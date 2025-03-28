// TODO: re-enable clippy warnings
#![allow(dead_code)]

use std::time::Duration;

use async_trait::async_trait;
use eyre::Result;
use uuid::Uuid;

use hyperlane_core::U256;

use crate::{
    payload::FullPayload,
    transaction::{Transaction, TransactionStatus},
};

pub type GasLimit = U256;

/// The `AdaptsChain` trait is implemented by adapters for different VMs, stacks and chains, allowing the `PayloadDispatcher` to interact with them in a generic way.
#[async_trait]
pub trait AdaptsChain: Send + Sync {
    /// Simulates Payload and returns its gas limit. Called in the Building Stage (PayloadDispatcher)
    async fn estimate_gas_limit(&self, payload: &FullPayload) -> Result<GasLimit>;

    /// Performs batching if available. Internally estimates gas limit for batch as well. Called in the Building Stage (PayloadDispatcher)
    async fn build_transactions(&self, payloads: Vec<FullPayload>) -> Result<Vec<Transaction>>;

    /// Simulates a Transaction before submitting it for the first time. Called in the Inclusion Stage (PayloadDispatcher)
    async fn simulate_tx(&self, tx: &Transaction) -> Result<bool>;

    /// Sets / escalates gas price, sets nonce / blockhash and broadcasts the Transaction. Even if broadcasting fails, the Transaction struct remains mutated with the new estimates. Called in the Inclusion Stage (PayloadDispatcher)
    async fn submit(&self, tx: &mut Transaction) -> Result<()>;

    /// Queries the chain by txhash to get the tx status. Called in the Inclusion Stage and Finality Stage of the PayloadDispatcher
    async fn tx_status(&self, tx: &Transaction) -> Result<TransactionStatus>;

    /// uses BatchManager, returns any reverted Payload IDs sent in a Transaction. Called in the Finality Stage (PayloadDispatcher)
    async fn reverted_payloads(&self, tx: &Transaction) -> Result<Vec<Uuid>>;

    /// Returns the estimated block time of the chain. Used for polling pending transactions. Called in the Inclusion and Finality Stages of the PayloadDispatcher
    fn estimated_block_time(&self) -> Result<Duration>;

    /// Returns the maximum batch size for this chain. Used to decide how many payloads to batch together, as well as
    /// how many network calls to perform in parallel
    fn max_batch_size(&self) -> usize;

    // methods below are excluded from the MVP

    /// Checks if a nonce gap exists in transactions submitted by the PayloadDispatcher via this adapter
    async fn nonce_gap_exists(&self) -> bool {
        todo!()
    }

    /// Replaces calldata in this tx with a transfer-to-self, to use its payload(s) for filling a nonce gap
    async fn replace_tx(&self, _tx: &Transaction) -> Result<()> {
        todo!()
    }
}
