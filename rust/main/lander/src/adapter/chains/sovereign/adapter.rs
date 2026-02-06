#[cfg(test)]
pub mod tests;

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;

use hyperlane_base::{settings::ChainConf, CoreMetrics};
use hyperlane_core::{ChainCommunicationError, H256, H512};
use hyperlane_sovereign::{
    ConnectionConf, Signer, SimulateResult, SovereignProvider, SovereignProviderForLander, TxResult,
};

use crate::{
    adapter::{AdaptsChain, GasLimit, TxBuildingResult},
    error::LanderError,
    payload::{FullPayload, PayloadDetails},
    transaction::{Transaction, TransactionStatus},
    DispatcherMetrics,
};

use super::precursor::{GasEstimate, SovereignTxPrecursor};
use super::transaction::Precursor;

/// Convert H256 to H512 with leading zero padding (Sovereign tx hash format).
fn h256_to_h512(h: H256) -> H512 {
    let mut bytes = [0u8; 64];
    bytes[32..].copy_from_slice(h.as_bytes());
    H512::from_slice(&bytes)
}

/// Extract H256 from H512 (last 32 bytes).
fn h512_to_h256(h: H512) -> H256 {
    H256::from_slice(&h.0[32..])
}

/// Adapter for Sovereign SDK chains in the lander.
pub struct SovereignAdapter {
    #[allow(dead_code)]
    pub conf: ChainConf,
    #[allow(dead_code)]
    pub connection_conf: ConnectionConf,
    pub provider: Arc<dyn SovereignProviderForLander>,
    #[allow(dead_code)]
    pub signer: Signer,
    pub estimated_block_time: Duration,
}

impl SovereignAdapter {
    /// Create a new SovereignAdapter from configuration.
    pub async fn from_conf(
        conf: &ChainConf,
        _core_metrics: &CoreMetrics,
        connection_conf: &ConnectionConf,
    ) -> Result<Self, LanderError> {
        let signer = Self::build_signer(conf)?;

        let provider =
            SovereignProvider::new(conf.domain.clone(), connection_conf, Some(signer.clone()))
                .await
                .map_err(LanderError::ChainCommunicationError)?;

        Ok(Self {
            conf: conf.clone(),
            connection_conf: connection_conf.clone(),
            provider: Arc::new(provider),
            signer,
            estimated_block_time: conf.estimated_block_time,
        })
    }

    fn build_signer(conf: &ChainConf) -> Result<Signer, LanderError> {
        use hyperlane_base::settings::SignerConf;

        let signer_conf = conf
            .signer
            .as_ref()
            .ok_or_else(|| LanderError::NonRetryableError("No signer configured".to_string()))?;

        match signer_conf {
            SignerConf::SovereignKey {
                key,
                account_type,
                hrp,
            } => Signer::new(key, account_type, hrp.clone())
                .map_err(|e| LanderError::NonRetryableError(format!("Signer error: {e}"))),
            _ => Err(LanderError::NonRetryableError(
                "Invalid signer type for Sovereign chain".to_string(),
            )),
        }
    }

    fn is_not_found_error(e: &ChainCommunicationError) -> bool {
        let err_str = e.to_string();
        err_str.contains("not found") || err_str.contains("404")
    }

    /// Check if transaction exists in the sequencer (soft-confirmed).
    /// If found, return Included so we wait for finalization without resubmitting.
    async fn check_tx_in_sequencer(&self, tx_hash: H256) -> Result<TransactionStatus, LanderError> {
        match self.provider.get_tx_from_sequencer(tx_hash).await {
            Ok(tx) => {
                // Tx exists in sequencer - it's soft-confirmed, waiting for processing
                tracing::debug!(
                    ?tx_hash,
                    tx_number = tx.tx_number,
                    "Tx found in sequencer (soft-confirmed)"
                );
                Ok(TransactionStatus::Included)
            }
            Err(e) => {
                if Self::is_not_found_error(&e) {
                    // Tx not found in sequencer either
                    Err(LanderError::TxHashNotFound(format!("{tx_hash:?}")))
                } else {
                    Err(LanderError::ChainCommunicationError(e))
                }
            }
        }
    }
}

#[async_trait]
impl AdaptsChain for SovereignAdapter {
    async fn estimate_gas_limit(
        &self,
        _payload: &FullPayload,
    ) -> Result<Option<GasLimit>, LanderError> {
        // Sovereign SDK uses multidimensional gas, so we return None
        // Gas estimation is handled during transaction submission
        Ok(None)
    }

    async fn build_transactions(&self, payloads: &[FullPayload]) -> Vec<TxBuildingResult> {
        payloads
            .iter()
            .map(|payload| {
                let maybe_tx = serde_json::from_slice(&payload.data)
                    .map_err(|err| {
                        tracing::error!(?err, "Failed to deserialize Sovereign call message");
                        err
                    })
                    .ok()
                    .map(|call_message| {
                        let precursor = SovereignTxPrecursor::new(call_message);
                        Transaction::new(precursor, vec![payload.details.clone()])
                    });

                TxBuildingResult {
                    payloads: vec![payload.details.clone()],
                    maybe_tx,
                }
            })
            .collect()
    }

    async fn simulate_tx(&self, tx: &mut Transaction) -> Result<Vec<PayloadDetails>, LanderError> {
        tracing::debug!(?tx, "Simulating Sovereign transaction");

        let call_message = &tx.precursor().call_message;
        let result = self
            .provider
            .simulate(call_message)
            .await
            .map_err(LanderError::ChainCommunicationError)?;

        match result {
            SimulateResult::Success(_) => {
                tracing::debug!(?tx, "Simulation succeeded");
                Ok(vec![])
            }
            SimulateResult::Reverted(r) => {
                tracing::warn!(?tx, detail = ?r.detail, "Simulation reverted");
                Err(LanderError::SimulationFailed(vec![format!(
                    "{:?}",
                    r.detail
                )]))
            }
            SimulateResult::Skipped(s) => {
                tracing::warn!(?tx, reason = ?s.reason, "Simulation skipped");
                Err(LanderError::SimulationFailed(vec![s.reason]))
            }
        }
    }

    async fn estimate_tx(&self, tx: &mut Transaction) -> Result<(), LanderError> {
        if tx.precursor().gas_estimate.is_some() {
            tracing::debug!(?tx, "Skipping estimation, already estimated");
            return Ok(());
        }

        tracing::debug!(?tx, "Estimating Sovereign transaction");

        let call_message = &tx.precursor().call_message;
        let result = self
            .provider
            .simulate(call_message)
            .await
            .map_err(LanderError::ChainCommunicationError)?;

        match result {
            SimulateResult::Success(s) => {
                let gas_used: u128 = s.gas_used.parse().map_err(|e| {
                    LanderError::NonRetryableError(format!("Failed to parse gas_used: {e}"))
                })?;
                let priority_fee: u128 = s.priority_fee.parse().map_err(|e| {
                    LanderError::NonRetryableError(format!("Failed to parse priority_fee: {e}"))
                })?;

                tracing::debug!(?tx, gas_used, priority_fee, "Estimation succeeded");
                tx.precursor_mut().gas_estimate = Some(GasEstimate {
                    gas_used,
                    priority_fee,
                });
                Ok(())
            }
            SimulateResult::Reverted(r) => {
                tracing::warn!(?tx, detail = ?r.detail, "Estimation reverted");
                Err(LanderError::SimulationFailed(vec![format!(
                    "{:?}",
                    r.detail
                )]))
            }
            SimulateResult::Skipped(s) => {
                tracing::warn!(?tx, reason = ?s.reason, "Estimation skipped");
                Err(LanderError::SimulationFailed(vec![s.reason]))
            }
        }
    }

    async fn submit(&self, tx: &mut Transaction) -> Result<(), LanderError> {
        tracing::info!(?tx, "Submitting Sovereign transaction");

        let call_message = tx.precursor().call_message.clone();

        let (response, serialized_body) = self
            .provider
            .build_and_submit(call_message)
            .await
            .map_err(LanderError::ChainCommunicationError)?;

        let tx_hash = h256_to_h512(response.id);

        if !tx.tx_hashes.contains(&tx_hash) {
            tx.tx_hashes.push(tx_hash);
        }

        // Update precursor with submission info
        let precursor = tx.precursor_mut();
        precursor.tx_hash = Some(response.id);
        precursor.serialized_body = Some(serialized_body);

        tracing::info!(tx_uuid = ?tx.uuid, ?tx_hash, "Submitted Sovereign transaction");
        Ok(())
    }

    async fn get_tx_hash_status(&self, hash: H512) -> Result<TransactionStatus, LanderError> {
        let tx_hash = h512_to_h256(hash);

        // First try the ledger endpoint (for processed/finalized transactions)
        match self.provider.get_tx_by_hash(tx_hash).await {
            Ok(tx) => match tx.receipt.result {
                TxResult::Successful => Ok(TransactionStatus::Finalized),
                TxResult::Reverted | TxResult::Skipped => Ok(TransactionStatus::Dropped(
                    crate::transaction::DropReason::DroppedByChain,
                )),
            },
            Err(e) => {
                if Self::is_not_found_error(&e) {
                    // Tx not in ledger yet - check sequencer for soft-confirmed status
                    self.check_tx_in_sequencer(tx_hash).await
                } else {
                    Err(LanderError::ChainCommunicationError(e))
                }
            }
        }
    }

    async fn reverted_payloads(
        &self,
        _tx: &Transaction,
    ) -> Result<Vec<PayloadDetails>, LanderError> {
        // Sovereign uses soft confirmations - once a transaction is successful,
        // it cannot revert later. No revert detection needed.
        Ok(Vec::new())
    }

    fn estimated_block_time(&self) -> &Duration {
        &self.estimated_block_time
    }

    fn max_batch_size(&self) -> u32 {
        // Sovereign doesn't support batching in the current implementation
        1
    }

    fn update_vm_specific_metrics(&self, _tx: &Transaction, _metrics: &DispatcherMetrics) {
        // TODO: Add Sovereign-specific metrics if needed
    }
}
