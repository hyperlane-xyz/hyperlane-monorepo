use std::sync::Arc;
use std::time::{Duration, Instant};

use ethers::types::transaction::eip2718::TypedTransaction;
use ethers::types::{TransactionReceipt, H160, H256 as EthersH256};
use hyperlane_core::config::OpSubmissionConfig;
use hyperlane_core::{HyperlaneDomain, KnownHyperlaneDomain, H256, U256};
use hyperlane_ethereum::EthereumReorgPeriod;

use crate::adapter::chains::ethereum::{
    tests::{dummy_evm_tx, ExpectedTxType, MockEvmProvider},
    EthereumAdapter, EthereumAdapterMetrics, NonceDb, NonceManager, NonceManagerState,
    NonceUpdater,
};
use crate::dispatcher::{DispatcherState, PayloadDb, TransactionDb};
use crate::tests::test_utils::tmp_dbs;
use crate::transaction::Transaction;
use crate::{DispatcherMetrics, FullPayload, PayloadStatus, TransactionStatus};

/// This is block time for unit tests which assume that we are ready to re-submit every time,
/// so, it is set to 0 nanoseconds so that we can test the inclusion stage without waiting
const TEST_DOMAIN: KnownHyperlaneDomain = KnownHyperlaneDomain::Arbitrum;

pub fn mocked_evm_provider() -> MockEvmProvider {
    let mut mock_evm_provider = MockEvmProvider::new();
    mock_finalized_block_number(&mut mock_evm_provider);
    mock_estimate_gas_limit(&mut mock_evm_provider);
    mock_get_block(&mut mock_evm_provider);
    mock_get_next_nonce_on_finalized_block(&mut mock_evm_provider);

    mock_evm_provider
        .expect_get_transaction_receipt()
        .returning(move |_| {
            Ok(Some(TransactionReceipt {
                transaction_hash: H256::random().into(),
                block_number: Some(444.into()),
                ..Default::default()
            }))
        });
    mock_evm_provider.expect_send().returning(|_, _| {
        Ok(H256::random()) // Mocked transaction hash
    });
    mock_evm_provider
        .expect_fee_history()
        .returning(|_, _, _| Ok(mock_fee_history(0, 0)));

    mock_evm_provider
}

pub async fn mock_evm_txs(
    num: usize,
    payload_db: &Arc<dyn PayloadDb>,
    tx_db: &Arc<dyn TransactionDb>,
    status: TransactionStatus,
    signer: H160,
    tx_type: ExpectedTxType,
) -> Vec<Transaction> {
    let mut txs = Vec::new();
    for _ in 0..num {
        let mut payload = FullPayload::random();
        payload.status = PayloadStatus::InTransaction(status.clone());
        payload_db.store_payload_by_uuid(&payload).await.unwrap();
        let tx = dummy_evm_tx(tx_type, vec![payload], status.clone(), signer);
        tx_db.store_transaction_by_uuid(&tx).await.unwrap();
        txs.push(tx);
    }
    txs
}

pub fn mock_dispatcher_state_with_provider(
    provider: MockEvmProvider,
    signer: H160,
    block_time: Duration,
    minimum_time_between_resubmissions: Duration,
) -> DispatcherState {
    let (payload_db, tx_db, nonce_db) = tmp_dbs();
    let adapter = mock_ethereum_adapter(
        provider,
        payload_db.clone(),
        tx_db.clone(),
        nonce_db,
        signer,
        block_time,
        minimum_time_between_resubmissions,
    );
    DispatcherState::new(
        payload_db,
        tx_db,
        Arc::new(adapter),
        DispatcherMetrics::dummy_instance(),
        "test".to_string(),
    )
}

pub fn mock_ethereum_adapter(
    provider: MockEvmProvider,
    payload_db: Arc<dyn PayloadDb>,
    tx_db: Arc<dyn TransactionDb>,
    nonce_db: Arc<dyn NonceDb>,
    signer: H160,
    block_time: Duration,
    minimum_time_between_resubmissions: Duration,
) -> EthereumAdapter {
    let domain: HyperlaneDomain = TEST_DOMAIN.into();
    let provider = Arc::new(provider);
    let reorg_period = EthereumReorgPeriod::Blocks(1);
    let metrics = EthereumAdapterMetrics::dummy_instance();
    let state = Arc::new(NonceManagerState::new(nonce_db, tx_db, signer, metrics));

    let nonce_updater = NonceUpdater::new(
        signer,
        reorg_period,
        block_time,
        provider.clone(),
        state.clone(),
    );

    let nonce_manager = NonceManager {
        address: signer,
        state,
        nonce_updater,
    };

    let op_submission_config = OpSubmissionConfig::default();
    let batch_contract_address = op_submission_config
        .batch_contract_address
        .unwrap_or_default();

    EthereumAdapter {
        estimated_block_time: block_time,
        domain,
        transaction_overrides: Default::default(),
        submission_config: op_submission_config,
        provider,
        reorg_period,
        nonce_manager,
        batch_cache: Default::default(),
        batch_contract_address,
        payload_db,
        signer,
        minimum_time_between_resubmissions,
    }
}

pub fn mock_fee_history(base_fee: u32, prio_fee: u32) -> ethers::types::FeeHistory {
    ethers::types::FeeHistory {
        oldest_block: 0.into(),
        reward: vec![vec![prio_fee.into()]],
        base_fee_per_gas: vec![base_fee.into()],
        gas_used_ratio: vec![0.0],
    }
}

pub fn mock_tx_receipt(block_number: Option<u64>, hash: H256) -> TransactionReceipt {
    TransactionReceipt {
        transaction_hash: hash.into(),
        block_number: block_number.map(|n| n.into()),
        ..Default::default()
    }
}

pub fn mock_block(block_number: u64, base_fee: u32) -> ethers::types::Block<EthersH256> {
    ethers::types::Block {
        number: Some(block_number.into()),
        base_fee_per_gas: Some(base_fee.into()),
        gas_limit: 30000000.into(),
        ..Default::default()
    }
}

pub fn mock_default_fee_history(mock_evm_provider: &mut MockEvmProvider) {
    mock_evm_provider
        .expect_fee_history()
        .returning(move |_, _, _| Ok(mock_fee_history(200000, 10)));
}

pub fn mock_finalized_block_number(mock_evm_provider: &mut MockEvmProvider) {
    mock_evm_provider
        .expect_get_finalized_block_number()
        .returning(|_reorg_period| Ok(43)); // Mocked block number
}

pub fn mock_estimate_gas_limit(mock_evm_provider: &mut MockEvmProvider) {
    mock_evm_provider
        .expect_estimate_gas_limit()
        .returning(|_, _| Ok(21000.into())); // Mocked gas limit
}

pub fn mock_get_block(mock_evm_provider: &mut MockEvmProvider) {
    mock_evm_provider
        .expect_get_block()
        .returning(|_| Ok(Some(mock_block(42, 100)))); // Mocked block retrieval
}

pub fn mock_get_next_nonce_on_finalized_block(mock_evm_provider: &mut MockEvmProvider) {
    mock_evm_provider
        .expect_get_next_nonce_on_finalized_block()
        .returning(move |_, _| Ok(U256::one()));
}

pub fn assert_gas_prices_and_timings(
    nth_submission: usize,
    start_time: Instant,
    base_processing_delay: Duration,
    inclusion_stage_processing_delay: Duration,
    block_time: Duration,
    tx: &TypedTransaction,
    gas_price_expectations: Vec<u32>,
) {
    let actual_elapsed = start_time.elapsed();
    let expected_elapsed = base_processing_delay
        + (inclusion_stage_processing_delay + block_time) * (nth_submission as u32);
    assert!(
        actual_elapsed < expected_elapsed,
        "(submission {nth_submission}) elapsed {actual_elapsed:?} was not < expected {expected_elapsed:?}"
    );
    assert_eq!(
        tx.gas_price().unwrap(),
        gas_price_expectations[nth_submission - 1].into(),
        "gas price for submission {nth_submission} doesn't match expected value"
    );
}
