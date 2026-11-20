use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;

use async_trait::async_trait;
use futures_util::future::join_all;
use hyperlane_core::{ChainCommunicationError, ChainResult};
use hyperlane_sealevel::{
    PriorityFeeOracle, SealevelProviderForLander, SealevelSigner, SealevelTransactionFormat,
    SealevelTxCostEstimate, SealevelTxType, TransactionSubmitter,
};
use solana_commitment_config::CommitmentConfig;
use solana_sdk::{
    account::Account, instruction::Instruction, message::Message, pubkey::Pubkey,
    signature::Signature, transaction::Transaction as LegacyTransaction,
};

use crate::adapter::AdaptsChain;

use super::super::{TransactionFactory, MAX_CONCURRENT_ESTIMATES};
use super::tests_common::{adapter, payload, precursor};

#[tokio::test]
async fn test_submit() {
    // given
    let adapter = adapter();
    let mut transaction = TransactionFactory::build(precursor(), &payload());

    // when
    let result = adapter.submit(&mut transaction).await;

    // then
    assert!(result.is_ok());
}

#[derive(Default)]
struct EstimateActivity {
    active: AtomicUsize,
    peak: AtomicUsize,
    total: AtomicUsize,
    fail: AtomicBool,
}

struct YieldingEstimateProvider(Arc<EstimateActivity>);

struct ActiveEstimate<'a>(&'a AtomicUsize);

impl Drop for ActiveEstimate<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

#[async_trait]
impl SealevelProviderForLander for YieldingEstimateProvider {
    async fn get_estimated_costs_for_instruction(
        &self,
        _instruction: Instruction,
        _payer: &SealevelSigner,
        _tx_submitter: Arc<dyn TransactionSubmitter>,
        _priority_fee_oracle: Arc<dyn PriorityFeeOracle>,
        _alt_addresses: &SealevelTransactionFormat,
    ) -> ChainResult<SealevelTxCostEstimate> {
        self.0.total.fetch_add(1, Ordering::Relaxed);
        let active = self.0.active.fetch_add(1, Ordering::Relaxed) + 1;
        let _active = ActiveEstimate(&self.0.active);
        self.0.peak.fetch_max(active, Ordering::Relaxed);
        tokio::task::yield_now().await;
        if self.0.fail.load(Ordering::Relaxed) {
            return Err(ChainCommunicationError::from_other_str(
                "estimate unavailable",
            ));
        }
        Ok(super::tests_common::estimate())
    }

    async fn create_transaction_for_instruction<'a>(
        &self,
        _compute_unit_limit: u32,
        _compute_unit_price_micro_lamports: u64,
        instruction: Instruction,
        payer: &'a SealevelSigner,
        _tx_submitter: Arc<dyn TransactionSubmitter>,
        _sign: bool,
        _alt_addresses: &SealevelTransactionFormat,
        _additional_signers: &'a [&'a SealevelSigner],
    ) -> ChainResult<SealevelTxType> {
        Ok(SealevelTxType::Legacy(LegacyTransaction::new_unsigned(
            Message::new(&[instruction], Some(&payer.pubkey())),
        )))
    }

    async fn wait_for_transaction_confirmation(
        &self,
        _transaction: &SealevelTxType,
    ) -> ChainResult<()> {
        unreachable!("submission does not wait for confirmation")
    }

    async fn confirm_transaction(
        &self,
        _signature: Signature,
        _commitment: CommitmentConfig,
    ) -> ChainResult<bool> {
        unreachable!("submission does not query confirmation")
    }

    async fn get_account(&self, _account: Pubkey) -> ChainResult<Option<Account>> {
        unreachable!("submission does not query accounts")
    }
}

#[tokio::test]
async fn stale_submissions_estimate_concurrently_with_backpressure() {
    let activity = Arc::new(EstimateActivity::default());
    let mut adapter = adapter();
    adapter.provider = Arc::new(YieldingEstimateProvider(activity.clone()));
    let mut transactions: Vec<_> = (0..MAX_CONCURRENT_ESTIMATES * 2)
        .map(|_| TransactionFactory::build(precursor(), &payload()))
        .collect();

    let results = join_all(transactions.iter_mut().map(|tx| adapter.submit(tx))).await;

    assert!(results.iter().all(Result::is_ok));
    assert_eq!(activity.total.load(Ordering::Relaxed), transactions.len());
    assert_eq!(
        activity.peak.load(Ordering::Relaxed),
        MAX_CONCURRENT_ESTIMATES
    );
    assert_eq!(activity.active.load(Ordering::Relaxed), 0);
    assert!(adapter.fresh_estimates.is_empty());
}

#[tokio::test]
async fn fresh_estimate_is_consumed_once_and_removed() {
    let activity = Arc::new(EstimateActivity::default());
    let mut adapter = adapter();
    adapter.provider = Arc::new(YieldingEstimateProvider(activity.clone()));
    let mut tx = TransactionFactory::build(precursor(), &payload());

    adapter
        .estimate_tx(&mut tx)
        .await
        .expect("prepare estimate");
    adapter
        .submit(&mut tx)
        .await
        .expect("submit fresh estimate");
    assert_eq!(activity.total.load(Ordering::Relaxed), 1);
    assert!(adapter.fresh_estimates.is_empty());

    adapter
        .submit(&mut tx)
        .await
        .expect("reestimate submission");
    assert_eq!(activity.total.load(Ordering::Relaxed), 2);
}

#[tokio::test]
async fn failed_estimate_releases_capacity_and_is_retried() {
    let activity = Arc::new(EstimateActivity::default());
    activity.fail.store(true, Ordering::Relaxed);
    let mut adapter = adapter();
    adapter.provider = Arc::new(YieldingEstimateProvider(activity.clone()));
    let mut tx = TransactionFactory::build(precursor(), &payload());

    assert!(adapter.estimate_tx(&mut tx).await.is_err());
    assert!(adapter.fresh_estimates.is_empty());
    assert_eq!(
        adapter.estimate_permits.available_permits(),
        MAX_CONCURRENT_ESTIMATES
    );

    activity.fail.store(false, Ordering::Relaxed);
    adapter
        .submit(&mut tx)
        .await
        .expect("retry failed estimate");
    assert_eq!(activity.total.load(Ordering::Relaxed), 2);
}

#[tokio::test]
async fn failed_reestimate_invalidates_an_earlier_fresh_estimate() {
    let activity = Arc::new(EstimateActivity::default());
    let mut adapter = adapter();
    adapter.provider = Arc::new(YieldingEstimateProvider(activity.clone()));
    let mut tx = TransactionFactory::build(precursor(), &payload());

    adapter
        .estimate_tx(&mut tx)
        .await
        .expect("initial estimate");
    assert!(adapter.fresh_estimates.contains_key(&tx.uuid));

    activity.fail.store(true, Ordering::Relaxed);
    assert!(adapter.estimate_tx(&mut tx).await.is_err());
    assert!(adapter.fresh_estimates.is_empty());
    assert_eq!(activity.active.load(Ordering::Relaxed), 0);
    assert_eq!(
        adapter.estimate_permits.available_permits(),
        MAX_CONCURRENT_ESTIMATES
    );

    // A stale marker would skip estimation and incorrectly submit successfully.
    assert!(adapter.submit(&mut tx).await.is_err());
    assert!(tx.tx_hashes.is_empty());
    assert_eq!(activity.total.load(Ordering::Relaxed), 3);

    activity.fail.store(false, Ordering::Relaxed);
    adapter
        .submit(&mut tx)
        .await
        .expect("retry with a new estimate");
    assert_eq!(activity.total.load(Ordering::Relaxed), 4);
}

#[tokio::test]
async fn cancelled_reestimate_invalidates_an_earlier_fresh_estimate() {
    let activity = Arc::new(EstimateActivity::default());
    let mut adapter = adapter();
    adapter.provider = Arc::new(YieldingEstimateProvider(activity.clone()));
    let mut tx = TransactionFactory::build(precursor(), &payload());
    adapter
        .estimate_tx(&mut tx)
        .await
        .expect("initial estimate");
    assert!(adapter.fresh_estimates.contains_key(&tx.uuid));

    let mut estimation = Box::pin(adapter.estimate_tx(&mut tx));
    assert!(futures_util::poll!(&mut estimation).is_pending());
    drop(estimation);
    assert!(adapter.fresh_estimates.is_empty());
    assert_eq!(activity.active.load(Ordering::Relaxed), 0);
    assert_eq!(
        adapter.estimate_permits.available_permits(),
        MAX_CONCURRENT_ESTIMATES
    );

    adapter
        .submit(&mut tx)
        .await
        .expect("retry cancelled refresh");
    assert_eq!(activity.total.load(Ordering::Relaxed), 3);
}

#[tokio::test]
async fn cancelled_estimate_releases_capacity_without_marking_fresh() {
    let activity = Arc::new(EstimateActivity::default());
    let mut adapter = adapter();
    adapter.provider = Arc::new(YieldingEstimateProvider(activity.clone()));
    let mut tx = TransactionFactory::build(precursor(), &payload());
    let mut estimation = Box::pin(adapter.estimate_tx(&mut tx));

    assert!(futures_util::poll!(&mut estimation).is_pending());
    assert_eq!(
        adapter.estimate_permits.available_permits(),
        MAX_CONCURRENT_ESTIMATES - 1
    );
    drop(estimation);

    assert_eq!(
        adapter.estimate_permits.available_permits(),
        MAX_CONCURRENT_ESTIMATES
    );
    assert_eq!(activity.active.load(Ordering::Relaxed), 0);
    assert!(adapter.fresh_estimates.is_empty());
    adapter
        .submit(&mut tx)
        .await
        .expect("retry cancelled estimate");
    assert_eq!(activity.total.load(Ordering::Relaxed), 2);
}

#[tokio::test]
async fn test_ready_for_resubmission() {
    // given
    let adapter = adapter();
    let mut transaction = TransactionFactory::build(precursor(), &payload());

    let expected_resubmission_time = adapter.time_before_resubmission();

    let now = chrono::Utc::now();
    let recent_but_too_soon_for_resubmission =
        now - expected_resubmission_time + Duration::from_millis(1);
    let recent_but_ready_for_resubmission = now - expected_resubmission_time;

    // when
    transaction.last_submission_attempt = Some(recent_but_too_soon_for_resubmission);
    let is_ready = adapter.tx_ready_for_resubmission(&transaction).await;
    assert!(!is_ready);

    transaction.last_submission_attempt = Some(recent_but_ready_for_resubmission);
    let is_ready = adapter.tx_ready_for_resubmission(&transaction).await;
    assert!(is_ready);
}

#[tokio::test]
async fn test_time_before_resubmission() {
    let mut adapter = adapter();
    // the block time of SOON SVM is 50ms
    adapter.estimated_block_time = Duration::from_millis(50);

    let expected_time_before_resubmission = adapter.estimated_block_time.mul_f32(3.0);

    assert_eq!(
        adapter.time_before_resubmission(),
        expected_time_before_resubmission
    );
}
