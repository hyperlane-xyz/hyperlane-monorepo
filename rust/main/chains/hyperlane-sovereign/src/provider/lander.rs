use hyperlane_core::{ChainResult, H256};
use serde_json::Value;

use crate::types::{SequencerTx, SimulateResult, SubmitTxResponse, Tx};
use crate::SovereignProvider;

/// Trait used by lander for Sovereign chain interactions.
#[async_trait::async_trait]
pub trait SovereignProviderForLander: Send + Sync {
    /// Simulate a transaction with the given call message.
    async fn simulate(&self, call_message: &Value) -> ChainResult<SimulateResult>;

    /// Build and submit a transaction to the rollup.
    async fn build_and_submit(&self, call_message: Value) -> ChainResult<(SubmitTxResponse, String)>;

    /// Get a transaction by its hash from the ledger (processed transactions only).
    async fn get_tx_by_hash(&self, tx_hash: H256) -> ChainResult<Tx>;

    /// Get transaction from the sequencer (includes soft-confirmed transactions).
    /// Returns Ok if tx exists in sequencer, Err with 404 if not found.
    async fn get_tx_from_sequencer(&self, tx_hash: H256) -> ChainResult<SequencerTx>;
}

#[async_trait::async_trait]
impl SovereignProviderForLander for SovereignProvider {
    async fn simulate(&self, call_message: &Value) -> ChainResult<SimulateResult> {
        self.client.simulate(call_message).await
    }

    async fn build_and_submit(&self, call_message: Value) -> ChainResult<(SubmitTxResponse, String)> {
        self.client.build_and_submit(call_message).await
    }

    async fn get_tx_by_hash(&self, tx_hash: H256) -> ChainResult<Tx> {
        self.client.get_tx_by_hash(tx_hash).await
    }

    async fn get_tx_from_sequencer(&self, tx_hash: H256) -> ChainResult<SequencerTx> {
        self.client.get_tx_from_sequencer(tx_hash).await
    }
}
