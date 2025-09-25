#[cfg(test)]
pub mod tests;

use std::{sync::Arc, time::Duration};

use hyperlane_core::H512;
use hyperlane_radix::{RadixProviderForLander, RadixSigner, RadixTxCalldata};
use radix_transactions::signing::PrivateKey;
use scrypto::network::NetworkDefinition;
use uuid::Uuid;

use crate::{
    adapter::{AdaptsChain, GasLimit, RadixTxPrecursor, TxBuildingResult},
    payload::PayloadDetails,
    transaction::{Transaction, TransactionUuid, VmSpecificTxData},
    DispatcherMetrics, FullPayload, LanderError, TransactionDropReason, TransactionStatus,
};

#[allow(dead_code)]
pub struct RadixAdapter {
    pub network: NetworkDefinition,
    pub provider: Arc<dyn RadixProviderForLander>,
    pub signer: RadixSigner,
    pub component_regex: regex::Regex,
    pub estimated_block_time: Duration,
}

#[async_trait::async_trait]
impl AdaptsChain for RadixAdapter {
    async fn estimate_gas_limit(
        &self,
        _payload: &FullPayload,
    ) -> Result<Option<GasLimit>, LanderError> {
        todo!()
    }

    async fn build_transactions(&self, payloads: &[FullPayload]) -> Vec<TxBuildingResult> {
        let mut build_txs = Vec::new();
        for full_payload in payloads {
            let operation_payload: RadixTxCalldata =
                match serde_json::from_slice(&full_payload.data) {
                    Ok(s) => s,
                    Err(err) => {
                        tracing::error!(?err, "Failed to deserialize RadixTxCalldata");
                        build_txs.push(TxBuildingResult {
                            payloads: vec![full_payload.details.clone()],
                            maybe_tx: None,
                        });
                        continue;
                    }
                };

            let precursor = RadixTxPrecursor::from(operation_payload);
            let tx = Transaction {
                uuid: TransactionUuid::new(Uuid::new_v4()),
                tx_hashes: vec![],
                vm_specific_data: VmSpecificTxData::Radix(Box::new(precursor)),
                payload_details: vec![full_payload.details.clone()],
                status: TransactionStatus::PendingInclusion,
                submission_attempts: 0,
                creation_timestamp: chrono::Utc::now(),
                last_submission_attempt: None,
                last_status_check: None,
            };

            build_txs.push(TxBuildingResult {
                payloads: vec![full_payload.details.clone()],
                maybe_tx: Some(tx),
            });
        }
        build_txs
    }

    async fn simulate_tx(&self, _tx: &mut Transaction) -> Result<Vec<PayloadDetails>, LanderError> {
        todo!()
    }

    async fn estimate_tx(&self, _tx: &mut Transaction) -> Result<(), LanderError> {
        todo!()
    }

    async fn submit(&self, _tx: &mut Transaction) -> Result<(), LanderError> {
        todo!()
    }

    async fn get_tx_hash_status(&self, hash: H512) -> Result<TransactionStatus, LanderError> {
        let resp = self
            .provider
            .get_tx_hash_status(hash)
            .await
            .map_err(LanderError::ChainCommunicationError)?;

        match resp.status {
            gateway_api_client::models::TransactionStatus::Unknown => {
                Err(LanderError::TxHashNotFound(format!("{:x}", hash)))
            }
            gateway_api_client::models::TransactionStatus::Pending => {
                Ok(TransactionStatus::Mempool)
            }
            gateway_api_client::models::TransactionStatus::Rejected => Ok(
                TransactionStatus::Dropped(TransactionDropReason::DroppedByChain),
            ),
            gateway_api_client::models::TransactionStatus::CommittedFailure => Ok(
                TransactionStatus::Dropped(TransactionDropReason::FailedSimulation),
            ),
            gateway_api_client::models::TransactionStatus::CommittedSuccess => {
                Ok(TransactionStatus::Finalized)
            }
        }
    }

    async fn tx_ready_for_resubmission(&self, _tx: &Transaction) -> bool {
        true
    }

    async fn reverted_payloads(
        &self,
        tx: &Transaction,
    ) -> Result<Vec<PayloadDetails>, LanderError> {
        let delivered_calldata_list: Vec<(RadixTxCalldata, &PayloadDetails)> = tx
            .payload_details
            .iter()
            .filter_map(|d| {
                let calldata = d
                    .success_criteria
                    .as_ref()
                    .and_then(|s| serde_json::from_slice(s).ok())?;
                Some((calldata, d))
            })
            .collect();

        let mut reverted = Vec::new();
        for (delivered_calldata, payload_details) in delivered_calldata_list {
            let success = self
                .provider
                .check_preview(&delivered_calldata)
                .await
                .unwrap_or(false);
            if !success {
                reverted.push(payload_details.clone());
            }
        }
        Ok(reverted)
    }

    fn estimated_block_time(&self) -> &Duration {
        todo!()
    }

    fn max_batch_size(&self) -> u32 {
        todo!()
    }

    fn update_vm_specific_metrics(&self, _tx: &Transaction, _metrics: &DispatcherMetrics) {
        todo!()
    }

    async fn nonce_gap_exists(&self) -> bool {
        todo!()
    }

    async fn replace_tx(&self, _tx: &Transaction) -> Result<(), LanderError> {
        todo!()
    }
}
