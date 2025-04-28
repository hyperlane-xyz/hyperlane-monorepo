use std::time::Duration;
use std::{collections::HashMap, sync::Arc};

use async_trait::async_trait;
use chrono::Utc;
use eyre::{bail, eyre, ContextCompat, Report};
use futures_util::future::join_all;
use serde_json::json;
use solana_client::rpc_response::{Response, RpcSimulateTransactionResult};
use solana_sdk::{
    commitment_config::CommitmentConfig,
    compute_budget::ComputeBudgetInstruction,
    instruction::AccountMeta,
    message::Message,
    pubkey::Pubkey,
    signature::{Signature, Signer},
    transaction::Transaction as SealevelTransaction,
};
use tracing::{info, instrument, warn};
use uuid::Uuid;

use hyperlane_base::{
    settings::{
        parser::h_sealevel::{
            client_builder::SealevelRpcClientBuilder, ConnectionConf, PriorityFeeOracle,
            SealevelKeypair, TransactionSubmitter,
        },
        BuildableWithSignerConf, ChainConf, ChainConnectionConf, RawChainConf, SignerConf,
    },
    CoreMetrics,
};
use hyperlane_core::{ChainResult, ReorgPeriod, H256, H512};
use hyperlane_sealevel::fallback::{SealevelFallbackRpcClient, SubmitSealevelRpc};
use hyperlane_sealevel::{
    PriorityFeeOracleConfig, SealevelProvider, SealevelProviderForSubmitter, SealevelTxCostEstimate,
};

use crate::chain_tx_adapter::{AdaptsChain, GasLimit};
use crate::payload::FullPayload;
use crate::transaction::{
    SignerAddress, Transaction, TransactionId, TransactionStatus, VmSpecificTxData,
};
use crate::TransactionDropReason;
use crate::{
    chain_tx_adapter::chains::sealevel::transaction::{Precursor, TransactionFactory, Update},
    error::SubmitterError,
};
use crate::{chain_tx_adapter::chains::sealevel::SealevelTxPrecursor, payload::PayloadDetails};
use crate::{
    chain_tx_adapter::{
        adapter::TxBuildingResult,
        chains::sealevel::conf::{create_keypair, get_connection_conf},
    },
    error,
};

const TX_RESUBMISSION_MIN_DELAY_SECS: u64 = 15;

pub struct SealevelTxAdapter {
    estimated_block_time: Duration,
    max_batch_size: u32,
    reorg_period: ReorgPeriod,
    keypair: SealevelKeypair,
    client: Box<dyn SubmitSealevelRpc>,
    provider: Box<dyn SealevelProviderForSubmitter>,
    oracle: Box<dyn PriorityFeeOracle>,
    submitter: Box<dyn TransactionSubmitter>,
}

impl SealevelTxAdapter {
    pub fn new(
        conf: ChainConf,
        raw_conf: RawChainConf,
        metrics: &CoreMetrics,
    ) -> eyre::Result<Self> {
        let connection_conf = get_connection_conf(&conf);
        let urls = &connection_conf.urls;
        let chain_info = conf.metrics_conf().chain;
        let client_metrics = metrics.client_metrics();

        let client = SealevelFallbackRpcClient::from_urls(
            chain_info.clone(),
            urls.clone(),
            client_metrics.clone(),
        );

        let provider = SealevelProvider::new(
            client.clone(),
            conf.domain.clone(),
            &[H256::zero()],
            connection_conf,
        );

        let oracle = connection_conf.priority_fee_oracle.create_oracle();

        let submitter = connection_conf.transaction_submitter.create_submitter(
            &Arc::new(provider.clone()),
            client_metrics.clone(),
            chain_info.clone(),
            conf.domain.clone(),
            connection_conf,
        );

        Self::new_internal(
            conf,
            raw_conf,
            Box::new(client),
            Box::new(provider),
            oracle,
            submitter,
        )
    }

    fn new_internal(
        conf: ChainConf,
        _raw_conf: RawChainConf,
        client: Box<dyn SubmitSealevelRpc>,
        provider: Box<dyn SealevelProviderForSubmitter>,
        oracle: Box<dyn PriorityFeeOracle>,
        submitter: Box<dyn TransactionSubmitter>,
    ) -> eyre::Result<Self> {
        let estimated_block_time = conf.estimated_block_time;
        let reorg_period = conf.reorg_period.clone();
        let max_batch_size = Self::batch_size(&conf)?;
        let keypair = create_keypair(&conf)?;

        Ok(Self {
            estimated_block_time,
            max_batch_size,
            reorg_period,
            keypair,
            provider,
            client,
            oracle,
            submitter,
        })
    }

    #[allow(unused)]
    #[cfg(test)]
    fn new_internal_default(
        client: Box<dyn SubmitSealevelRpc>,
        provider: Box<dyn SealevelProviderForSubmitter>,
        oracle: Box<dyn PriorityFeeOracle>,
        submitter: Box<dyn TransactionSubmitter>,
    ) -> Self {
        Self {
            estimated_block_time: Duration::from_secs(1),
            max_batch_size: 1,
            reorg_period: ReorgPeriod::default(),
            keypair: SealevelKeypair::default(),
            provider,
            client,
            oracle,
            submitter,
        }
    }

    fn batch_size(conf: &ChainConf) -> eyre::Result<u32> {
        Ok(conf
            .connection
            .operation_submission_config()
            .ok_or_else(|| eyre!("no operation batch config"))?
            .max_batch_size)
    }

    async fn estimate(
        &self,
        precursor: SealevelTxPrecursor,
    ) -> Result<SealevelTxPrecursor, SubmitterError> {
        let estimate = self
            .provider
            .get_estimated_costs_for_instruction(
                precursor.instruction.clone(),
                &self.keypair,
                &*self.submitter,
                &*self.oracle,
            )
            .await?;
        Ok(SealevelTxPrecursor::new(precursor.instruction, estimate))
    }

    async fn create_unsigned_transaction(
        &self,
        precursor: &SealevelTxPrecursor,
    ) -> ChainResult<SealevelTransaction> {
        self.create_sealevel_transaction(precursor, false).await
    }

    async fn create_signed_transaction(
        &self,
        precursor: &SealevelTxPrecursor,
    ) -> ChainResult<SealevelTransaction> {
        self.create_sealevel_transaction(precursor, true).await
    }

    async fn create_sealevel_transaction(
        &self,
        precursor: &SealevelTxPrecursor,
        sign: bool,
    ) -> ChainResult<SealevelTransaction> {
        let SealevelTxPrecursor {
            instruction,
            estimate,
        } = precursor;

        self.provider
            .create_transaction_for_instruction(
                estimate.compute_units,
                estimate.compute_unit_price_micro_lamports,
                instruction.clone(),
                &self.keypair,
                &*self.submitter,
                sign,
            )
            .await
    }

    #[instrument(skip(self))]
    async fn get_tx_hash_status(&self, tx_hash: H512) -> Result<TransactionStatus, SubmitterError> {
        let signature = Signature::new(tx_hash.as_ref());
        let transaction_search_result = self.client.get_transaction(signature).await;

        let transaction = match transaction_search_result {
            Ok(transaction) => transaction,
            Err(err) => {
                warn!(?err, "Failed to get transaction status by hash");
                return Err(SubmitterError::TxSubmissionError(
                    "Transaction hash not found".to_string(),
                ));
            }
        };

        // slot at which transaction was included into blockchain
        let inclusion_slot = transaction.slot;

        info!(slot = ?inclusion_slot, "found transaction");

        // if block with this slot is added to the chain, transaction is considered to be confirmed
        let confirming_slot = inclusion_slot + self.reorg_period.as_blocks()? as u64;

        let confirming_block = self.client.get_block(confirming_slot).await;

        if confirming_block.is_ok() {
            info!("finalized transaction");
            return Ok(TransactionStatus::Finalized);
        }

        // block which includes transaction into blockchain
        let including_block = self.client.get_block(inclusion_slot).await;

        match including_block {
            Ok(_) => {
                info!("included transaction");
                Ok(TransactionStatus::Included)
            }
            Err(_) => {
                info!("pending transaction");
                Ok(TransactionStatus::PendingInclusion)
            }
        }
    }

    fn classify_tx_status_from_hash_statuses(
        statuses: Vec<Result<TransactionStatus, SubmitterError>>,
    ) -> TransactionStatus {
        let mut status_counts = HashMap::<TransactionStatus, usize>::new();

        // if none are finalized or included but there is at least one `PendingInclusion` or `Mempool`, return that
        for hash_status_result in statuses.iter() {
            if let Ok(status) = hash_status_result {
                *status_counts.entry(status.clone()).or_insert(0) += 1;
            }
        }

        // if any are finalized, return `Finalized`
        if let Some(finalized_count) = status_counts.get(&TransactionStatus::Finalized) {
            if *finalized_count > 0 {
                return TransactionStatus::Finalized;
            }
        }
        // if any are included, return `Included`
        if let Some(included_count) = status_counts.get(&TransactionStatus::Included) {
            if *included_count > 0 {
                return TransactionStatus::Included;
            }
        }
        // if any are pending, return `PendingInclusion`
        if let Some(pending_count) = status_counts.get(&TransactionStatus::PendingInclusion) {
            if *pending_count > 0 {
                return TransactionStatus::PendingInclusion;
            }
        }
        // if any are in mempool, return `Mempool`
        if let Some(mempool_count) = status_counts.get(&TransactionStatus::Mempool) {
            if *mempool_count > 0 {
                return TransactionStatus::Mempool;
            }
        }
        // if the hashmap is not empty, it must mean that the hashes were dropped
        if !status_counts.is_empty() {
            return TransactionStatus::Dropped(TransactionDropReason::DroppedByChain);
        }

        // otherwise, return `PendingInclusion`, assuming the rpc is down temporarily and returns errors
        TransactionStatus::PendingInclusion
    }
}

#[async_trait]
impl AdaptsChain for SealevelTxAdapter {
    async fn estimate_gas_limit(
        &self,
        payload: &FullPayload,
    ) -> Result<Option<GasLimit>, SubmitterError> {
        info!(?payload, "estimating payload");
        let not_estimated = SealevelTxPrecursor::from_payload(payload);
        let estimated = self.estimate(not_estimated).await?;
        info!(?payload, ?estimated, "estimated payload");
        Ok(Some(estimated.estimate.compute_units.into()))
    }

    async fn build_transactions(&self, payloads: &[FullPayload]) -> Vec<TxBuildingResult> {
        info!(?payloads, "building transactions for payloads");
        let payloads_and_precursors = payloads
            .iter()
            .map(|payload| (SealevelTxPrecursor::from_payload(payload), payload))
            .collect::<Vec<(SealevelTxPrecursor, &FullPayload)>>();

        let mut transactions = Vec::new();
        for (not_estimated, payload) in payloads_and_precursors.into_iter() {
            let Ok(estimated) = self.estimate(not_estimated).await else {
                transactions.push(TxBuildingResult::new(vec![payload.details.clone()], None));
                continue;
            };
            let transaction = TransactionFactory::build(payload, estimated);
            transactions.push(TxBuildingResult::new(
                vec![payload.details.clone()],
                Some(transaction),
            ))
        }

        info!(?payloads, ?transactions, "built transactions for payloads");
        transactions
    }

    async fn simulate_tx(&self, tx: &Transaction) -> Result<bool, SubmitterError> {
        info!(?tx, "simulating transaction");
        let precursor = tx.precursor();
        let svm_transaction = self.create_unsigned_transaction(precursor).await?;
        let success = self
            .client
            .simulate_transaction(&svm_transaction)
            .await
            .is_ok();
        info!(?tx, success, "simulated transaction");
        Ok(success)
    }

    async fn submit(&self, tx: &mut Transaction) -> Result<(), SubmitterError> {
        info!(?tx, "submitting transaction");
        let not_estimated = tx.precursor();
        // TODO: the `estimate` call shouldn't happen here - the `Transaction` argument should already contain the precursor,
        // set in the `build_transactions` method
        let estimated = self.estimate(not_estimated.clone()).await?;
        let svm_transaction = self.create_signed_transaction(&estimated).await?;
        let signature = self
            .submitter
            .send_transaction(&svm_transaction, true)
            .await?;

        let hash = signature.into();
        tx.update_after_submission(hash, estimated);

        info!(?tx, "submitted transaction");

        self.submitter
            .wait_for_transaction_confirmation(&svm_transaction)
            .await?;

        info!(?tx, "confirmed transaction by signature status");

        Ok(())
    }

    #[instrument(skip(self))]
    async fn tx_status(&self, tx: &Transaction) -> Result<TransactionStatus, SubmitterError> {
        info!(?tx, "checking status of transaction");

        if tx.tx_hashes.is_empty() {
            return Ok(TransactionStatus::PendingInclusion);
        }

        let hash_status_futures = tx
            .tx_hashes
            .iter()
            .map(|tx_hash| self.get_tx_hash_status(*tx_hash))
            .collect::<Vec<_>>();
        let hash_status_results = join_all(hash_status_futures).await;
        Ok(Self::classify_tx_status_from_hash_statuses(
            hash_status_results,
        ))
    }

    async fn reverted_payloads(
        &self,
        _tx: &Transaction,
    ) -> Result<Vec<PayloadDetails>, SubmitterError> {
        // Dummy implementation of reverted payloads for Sealevel since we don't have batching for Sealevel
        Ok(Vec::new())
    }

    fn estimated_block_time(&self) -> &Duration {
        &self.estimated_block_time
    }

    fn max_batch_size(&self) -> u32 {
        self.max_batch_size
    }

    async fn tx_ready_for_resubmission(&self, tx: &Transaction) -> bool {
        let last_submission_time = tx
            .last_submission_attempt
            .unwrap_or_else(|| tx.creation_timestamp);
        let seconds_since_last_submission =
            (Utc::now() - last_submission_time).num_seconds() as u64;
        seconds_since_last_submission >= TX_RESUBMISSION_MIN_DELAY_SECS
    }
}

#[cfg(test)]
mod tests;
