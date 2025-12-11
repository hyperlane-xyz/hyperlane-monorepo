use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;

use hyperlane_aleo::{AleoProvider, AleoProviderForLander, AleoSigner};
use hyperlane_base::settings::ChainConf;
use hyperlane_base::CoreMetrics;
use hyperlane_core::{ContractLocator, H256, H512};

use crate::adapter::{AdaptsChain, GasLimit, TxBuildingResult};
use crate::payload::PayloadDetails;
use crate::transaction::Transaction;
use crate::{DispatcherMetrics, FullPayload, LanderError, TransactionStatus};

use super::super::conf::create_signer;
use super::super::transaction::Precursor;
use super::build::build_transaction_from_payload;
use super::status;
use super::submit::submit_transaction;

pub struct AleoAdapter<P: AleoProviderForLander = AleoProvider> {
    pub provider: Arc<P>,
    pub estimated_block_time: Duration,
}

impl AleoAdapter<AleoProvider> {
    pub fn from_conf(
        conf: &ChainConf,
        metrics: &CoreMetrics,
        connection_conf: &hyperlane_aleo::ConnectionConf,
    ) -> Result<Self, LanderError> {
        // We must have a signer if we want to land transactions.
        let signer = create_signer(conf)?;

        let metrics = metrics.client_metrics();
        let middleware_metrics = conf.metrics_conf();

        let provider = AleoProvider::new(
            connection_conf,
            conf.domain.clone(),
            Some(signer.clone()),
            metrics,
            middleware_metrics.chain.clone(),
        )
        .map_err(|e| {
            LanderError::NonRetryableError(format!("Failed to create Aleo provider: {e}"))
        })?;

        Ok(Self {
            provider: Arc::new(provider),
            estimated_block_time: conf.estimated_block_time,
        })
    }
}

#[async_trait]
impl<P: AleoProviderForLander> AdaptsChain for AleoAdapter<P> {
    async fn estimate_gas_limit(
        &self,
        _payload: &FullPayload,
    ) -> Result<Option<GasLimit>, LanderError> {
        todo!()
    }

    async fn build_transactions(&self, payloads: &[FullPayload]) -> Vec<TxBuildingResult> {
        payloads
            .iter()
            .map(build_transaction_from_payload)
            .collect()
    }

    async fn simulate_tx(&self, _tx: &mut Transaction) -> Result<Vec<PayloadDetails>, LanderError> {
        // Aleo doesn't need simulation - transactions either succeed or fail atomically
        // No payload-level revert detection needed
        Ok(Vec::new())
    }

    async fn estimate_tx(&self, _tx: &mut Transaction) -> Result<(), LanderError> {
        // Aleo doesn't use gas limits - fees are calculated differently
        // Fee estimation happens in submit() right before transaction submission
        Ok(())
    }

    async fn submit(&self, tx: &mut Transaction) -> Result<(), LanderError> {
        submit_transaction(&*self.provider, tx).await
    }

    async fn get_tx_hash_status(&self, hash: H512) -> Result<TransactionStatus, LanderError> {
        status::get_tx_hash_status(&self.provider, hash).await
    }

    async fn tx_ready_for_resubmission(&self, tx: &Transaction) -> bool {
        self.ready_for_resubmission(tx)
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

    fn update_vm_specific_metrics(&self, _tx: &Transaction, _metrics: &DispatcherMetrics) {
        // TODO: Add Aleo-specific metrics if needed
    }
}

#[cfg(test)]
pub(crate) mod tests;
