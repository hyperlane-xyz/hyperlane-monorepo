use std::{sync::Arc, time::Duration};

use hyperlane_core::H512;
use hyperlane_radix::{DeliveredCalldata, RadixProcessCalldata, RadixProviderForLander};
use uuid::Uuid;

use crate::{
    adapter::{
        chains::radix::precursor::RadixTxPrecursor, AdaptsChain, GasLimit, TxBuildingResult,
    },
    payload::PayloadDetails,
    transaction::{Transaction, TransactionUuid, VmSpecificTxData},
    DispatcherMetrics, FullPayload, LanderError, TransactionDropReason, TransactionStatus,
};

#[derive(Clone)]
pub struct RadixAdapter {
    pub provider: Arc<dyn RadixProviderForLander>,
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
            let tx_payloads = Vec::new();

            let operation_payload: RadixProcessCalldata =
                serde_json::from_slice(&full_payload.data).unwrap();

            let precursor = RadixTxPrecursor {
                raw_tx: operation_payload.raw_tx,
                tx_hash: operation_payload.tx_hash.clone(),
            };
            let tx = Transaction {
                uuid: TransactionUuid::new(Uuid::new_v4()),
                tx_hashes: vec![],
                vm_specific_data: VmSpecificTxData::Radix(precursor),
                payload_details: vec![full_payload.details.clone()],
                status: TransactionStatus::PendingInclusion,
                submission_attempts: 0,
                creation_timestamp: chrono::Utc::now(),
                last_submission_attempt: None,
                last_status_check: None,
            };
            build_txs.push(TxBuildingResult {
                payloads: tx_payloads,
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
        let delivered_calldata_list: Vec<(DeliveredCalldata, &PayloadDetails)> = tx
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

#[cfg(test)]
mod tests {
    use gateway_api_client::models::TransactionStatusResponse;
    use hyperlane_core::ChainResult;

    use super::*;

    mockall::mock! {
        pub MockRadixProviderForLander {

        }

        #[async_trait::async_trait]
        impl RadixProviderForLander for MockRadixProviderForLander {
            async fn get_tx_hash_status(&self, hash: H512) -> ChainResult<TransactionStatusResponse>;
            async fn check_preview(&self, params: &DeliveredCalldata) -> ChainResult<bool>;
        }
    }

    #[tokio::test]
    async fn get_tx_hash_status_pending() {
        let mut provider = MockMockRadixProviderForLander::new();

        provider.expect_get_tx_hash_status().returning(|_| {
            Ok(TransactionStatusResponse {
                status: gateway_api_client::models::TransactionStatus::Pending,
                ..Default::default()
            })
        });

        let adapter = RadixAdapter {
            provider: Arc::new(provider),
        };

        let hash = H512::zero();
        let tx_status = adapter
            .get_tx_hash_status(hash)
            .await
            .expect("Failed to get tx hash status");

        assert_eq!(tx_status, TransactionStatus::Mempool);
    }

    #[tokio::test]
    async fn get_tx_hash_status_rejected() {
        let mut provider = MockMockRadixProviderForLander::new();

        provider.expect_get_tx_hash_status().returning(|_| {
            Ok(TransactionStatusResponse {
                status: gateway_api_client::models::TransactionStatus::Rejected,
                ..Default::default()
            })
        });

        let adapter = RadixAdapter {
            provider: Arc::new(provider),
        };

        let hash = H512::zero();
        let tx_status = adapter
            .get_tx_hash_status(hash)
            .await
            .expect("Failed to get tx hash status");

        assert_eq!(
            tx_status,
            TransactionStatus::Dropped(TransactionDropReason::DroppedByChain)
        );
    }

    #[tokio::test]
    async fn get_tx_hash_status_unknown() {
        let mut provider = MockMockRadixProviderForLander::new();

        provider.expect_get_tx_hash_status().returning(|_| {
            Ok(TransactionStatusResponse {
                status: gateway_api_client::models::TransactionStatus::Unknown,
                ..Default::default()
            })
        });

        let adapter = RadixAdapter {
            provider: Arc::new(provider),
        };

        let hash = H512::zero();
        let tx_status = adapter.get_tx_hash_status(hash.clone()).await;

        match tx_status {
            Err(LanderError::TxHashNotFound(tx_hash)) => {
                assert_eq!(tx_hash, format!("{:x}", hash));
            }
            val => {
                panic!("Incorrect status {:?}", val);
            }
        }
    }

    #[tokio::test]
    async fn get_tx_hash_status_committed_failure() {
        let mut provider = MockMockRadixProviderForLander::new();

        provider.expect_get_tx_hash_status().returning(|_| {
            Ok(TransactionStatusResponse {
                status: gateway_api_client::models::TransactionStatus::CommittedFailure,
                ..Default::default()
            })
        });

        let adapter = RadixAdapter {
            provider: Arc::new(provider),
        };

        let hash = H512::zero();
        let tx_status = adapter
            .get_tx_hash_status(hash.clone())
            .await
            .expect("Failed to get tx hash status");

        assert_eq!(
            tx_status,
            TransactionStatus::Dropped(TransactionDropReason::FailedSimulation)
        );
    }

    #[tokio::test]
    async fn get_tx_hash_status_committed_success() {
        let mut provider = MockMockRadixProviderForLander::new();

        provider.expect_get_tx_hash_status().returning(|_| {
            Ok(TransactionStatusResponse {
                status: gateway_api_client::models::TransactionStatus::CommittedSuccess,
                ..Default::default()
            })
        });

        let adapter = RadixAdapter {
            provider: Arc::new(provider),
        };

        let hash = H512::zero();
        let tx_status = adapter
            .get_tx_hash_status(hash.clone())
            .await
            .expect("Failed to get tx hash status");

        assert_eq!(tx_status, TransactionStatus::Finalized);
    }
}
