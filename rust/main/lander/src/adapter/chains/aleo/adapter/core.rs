use std::time::Duration;

use async_trait::async_trait;

use hyperlane_aleo::{AleoProvider, AleoProviderForLander};
use hyperlane_base::settings::ChainConf;
use hyperlane_base::CoreMetrics;
use hyperlane_core::H512;

use crate::adapter::chains::aleo::adapter::build::build_transaction_from_payload;
use crate::adapter::{AdaptsChain, GasLimit, TxBuildingResult};
use crate::payload::PayloadDetails;
use crate::transaction::Transaction;
use crate::{DispatcherMetrics, FullPayload, LanderError, TransactionStatus};

pub struct AleoAdapter {
    pub estimated_block_time: Duration,
}

impl AleoAdapter {
    pub fn from_conf(
        conf: &ChainConf,
        _metrics: &CoreMetrics,
        _connection_conf: &hyperlane_aleo::ConnectionConf,
    ) -> Result<Self, LanderError> {
        Ok(Self {
            estimated_block_time: conf.estimated_block_time,
        })
    }
}

#[async_trait]
impl AdaptsChain for AleoAdapter {
    async fn estimate_gas_limit(
        &self,
        _payload: &FullPayload,
    ) -> Result<Option<GasLimit>, LanderError> {
        // Aleo doesn't use traditional gas limits, fees are calculated differently
        Ok(None)
    }

    async fn build_transactions(&self, payloads: &[FullPayload]) -> Vec<TxBuildingResult> {
        payloads
            .iter()
            .map(build_transaction_from_payload)
            .collect()
    }

    async fn simulate_tx(&self, _tx: &mut Transaction) -> Result<Vec<PayloadDetails>, LanderError> {
        Ok(Vec::new())
    }

    async fn estimate_tx(&self, _tx: &mut Transaction) -> Result<(), LanderError> {
        // Fee estimation is done in simulate_tx for Aleo
        Ok(())
    }

    async fn submit(&self, _tx: &mut Transaction) -> Result<(), LanderError> {
        Ok(())
    }

    async fn get_tx_hash_status(&self, _hash: H512) -> Result<TransactionStatus, LanderError> {
        Ok(TransactionStatus::PendingInclusion)
    }

    async fn tx_ready_for_resubmission(&self, _tx: &Transaction) -> bool {
        // Aleo transactions with ZK proofs cannot be resubmitted with escalated fees
        // Once a transaction is created, it must either succeed or fail
        false
    }

    async fn reverted_payloads(
        &self,
        _tx: &Transaction,
    ) -> Result<Vec<PayloadDetails>, LanderError> {
        // For Aleo, if a transaction is finalized but rejected, all payloads in it are reverted
        // This is handled by the transaction status check
        Ok(Vec::new())
    }

    fn estimated_block_time(&self) -> &Duration {
        &self.estimated_block_time
    }

    fn max_batch_size(&self) -> u32 {
        // Aleo doesn't support batching multiple operations in a single transaction
        1
    }

    fn update_vm_specific_metrics(&self, _tx: &Transaction, _metrics: &DispatcherMetrics) {
        // TODO: Add Aleo-specific metrics if needed
    }

    async fn nonce_gap_exists(&self) -> bool {
        // Aleo doesn't use nonces, it uses ZK proofs with random seeds
        false
    }

    async fn replace_tx(&self, _tx: &Transaction) -> Result<(), LanderError> {
        // Aleo transactions cannot be replaced once created due to ZK proof binding
        Ok(())
    }
}

#[cfg(test)]
mod tests;
