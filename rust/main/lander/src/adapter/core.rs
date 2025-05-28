// TODO: re-enable clippy warnings
#![allow(dead_code)]

use std::time::Duration;

use async_trait::async_trait;
use derive_new::new;
use futures_util::future::join_all;
use tokio::sync::mpsc::error::SendError;
use tracing::{info, instrument};
use uuid::Uuid;

use hyperlane_core::{H256, H512, U256};

use crate::{
    error::LanderError,
    payload::{FullPayload, PayloadDetails},
    transaction::{Transaction, TransactionStatus},
};

pub type GasLimit = U256;

#[derive(new, Debug, Clone)]
pub struct TxBuildingResult {
    /// payload details for the payloads in this transaction
    /// this is a vector because multiple payloads can be included in a single transaction
    pub payloads: Vec<PayloadDetails>,
    /// the transaction itself
    /// this is an option because the transaction may have failed to be built
    pub maybe_tx: Option<Transaction>,
}

/// The `AdaptsChain` trait is implemented by adapters for different VMs, stacks and chains, allowing the `PayloadDispatcher` to interact with them in a generic way.
#[async_trait]
pub trait AdaptsChain: Send + Sync {
    /// Simulates Payload and returns its gas limit. Called in the Building Stage (PayloadDispatcher)
    async fn estimate_gas_limit(
        &self,
        payload: &FullPayload,
    ) -> Result<Option<GasLimit>, LanderError>;

    /// Performs batching if available. Internally estimates gas limit for batch as well. Called in the Building Stage (PayloadDispatcher)
    async fn build_transactions(&self, payloads: &[FullPayload]) -> Vec<TxBuildingResult>;

    /// Simulates a Transaction before submitting it for the first time. Called in the Inclusion Stage (PayloadDispatcher)
    async fn simulate_tx(&self, tx: &Transaction) -> Result<bool, LanderError>;

    /// Estimates a Transaction before submitting it for the first time. Called in the Inclusion Stage (PayloadDispatcher)
    async fn estimate_tx(&self, tx: &mut Transaction) -> Result<(), LanderError>;

    /// Sets / escalates gas price, sets nonce / blockhash and broadcasts the Transaction. Even if broadcasting fails, the Transaction struct remains mutated with the new estimates. Called in the Inclusion Stage (PayloadDispatcher)
    async fn submit(&self, tx: &mut Transaction) -> Result<(), LanderError>;

    async fn get_tx_hash_status(&self, hash: H512) -> Result<TransactionStatus, LanderError>;

    /// Queries the chain by txhash to get the tx status. Called in the Inclusion Stage and Finality Stage of the PayloadDispatcher
    #[instrument(skip(self))]
    async fn tx_status(&self, tx: &Transaction) -> Result<TransactionStatus, LanderError> {
        info!(?tx, "checking status of transaction");

        if tx.tx_hashes.is_empty() {
            return Ok(TransactionStatus::PendingInclusion);
        }

        let hash_status_futures = tx
            .tx_hashes
            .iter()
            .map(|tx_hash| self.get_tx_hash_status(*tx_hash))
            .collect::<Vec<_>>();
        // this may lead to rate limiting if too many hashes build up. Consider querying from most recent to oldest
        let hash_status_results = join_all(hash_status_futures).await;
        Ok(TransactionStatus::classify_tx_status_from_hash_statuses(
            hash_status_results,
        ))
    }

    /// Return true if the transaction can be resubmitted (such as by escalating the gas price). Called in the Inclusion Stage (PayloadDispatcher).
    /// Defaults to true, since most chains don't have special rules for tx resubmission.
    async fn tx_ready_for_resubmission(&self, _tx: &Transaction) -> bool {
        true
    }

    /// Uses BatchManager, returns any reverted Payload IDs sent in a Transaction.
    /// Called in the Finality Stage (PayloadDispatcher).
    async fn reverted_payloads(
        &self,
        _tx: &Transaction,
    ) -> Result<Vec<PayloadDetails>, LanderError> {
        Ok(Vec::new())
    }

    /// Returns the estimated block time of the chain. Used for polling pending transactions. Called in the Inclusion and Finality Stages of the PayloadDispatcher
    fn estimated_block_time(&self) -> &Duration;

    /// Returns the maximum batch size for this chain. Used to decide how many payloads to batch together, as well as
    /// how many network calls to perform in parallel
    fn max_batch_size(&self) -> u32;

    // methods below are excluded from the MVP

    /// Checks if a nonce gap exists in transactions submitted by the PayloadDispatcher via this adapter
    async fn nonce_gap_exists(&self) -> bool {
        todo!()
    }

    /// Replaces calldata in this tx with a transfer-to-self, to use its payload(s) for filling a nonce gap
    async fn replace_tx(&self, _tx: &Transaction) -> Result<(), LanderError> {
        todo!()
    }

    async fn set_unfinalized_tx_count(&self, _count: usize) {
        // nothing as default implementation
    }
}
