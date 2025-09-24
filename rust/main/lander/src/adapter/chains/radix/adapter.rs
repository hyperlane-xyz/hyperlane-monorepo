use std::{sync::Arc, time::Duration};

use hyperlane_core::H512;
use hyperlane_radix::{RadixProviderForLander, RadixSigner, RadixTxCalldata};
use radix_transactions::signing::PrivateKey;
use scrypto::network::NetworkDefinition;
use uuid::Uuid;

use crate::{
    adapter::{
        chains::radix::precursor::RadixTxPrecursor, AdaptsChain, GasLimit, TxBuildingResult,
    },
    payload::PayloadDetails,
    transaction::{Transaction, TransactionUuid, VmSpecificTxData},
    DispatcherMetrics, FullPayload, LanderError, TransactionDropReason, TransactionStatus,
};

#[allow(dead_code)]
pub struct RadixAdapter {
    pub network: NetworkDefinition,
    pub provider: Arc<dyn RadixProviderForLander>,
    pub signer: RadixSigner,
    pub private_key: PrivateKey,
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
            let tx_payloads = Vec::new();

            let operation_payload: RadixTxCalldata =
                serde_json::from_slice(&full_payload.data).unwrap();

            let precursor = RadixTxPrecursor::from(operation_payload);
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

#[cfg(test)]
mod tests {
    use ethers::utils::hex;
    use gateway_api_client::models::{TransactionStatusResponse, TransactionSubmitResponse};
    use hyperlane_core::ChainResult;
    use radix_common::crypto::Ed25519PrivateKey;

    use crate::adapter::chains::radix::tests::MockRadixProvider;

    use super::*;

    // random private key used for testing
    const TEST_PRIVATE_KEY: &str =
        "E99BC4A79BCE79A990322FBE97E2CEFF85C5DB7B39C495215B6E2C7020FD103D";

    fn build_adapter(provider: Arc<MockRadixProvider>, signer: RadixSigner) -> RadixAdapter {
        let private_key = signer.get_signer().expect("Failed to get private key");
        RadixAdapter {
            provider,
            network: NetworkDefinition::mainnet(),
            private_key,
            signer,
            estimated_block_time: Duration::from_nanos(0),
            component_regex: regex::Regex::new("").unwrap(),
        }
    }

    #[tokio::test]
    async fn get_tx_hash_status_pending() {
        let mut provider = MockRadixProvider::new();

        provider.expect_get_tx_hash_status().returning(|_| {
            Ok(TransactionStatusResponse {
                status: gateway_api_client::models::TransactionStatus::Pending,
                ..Default::default()
            })
        });

        let priv_key_vec = hex::decode(TEST_PRIVATE_KEY).expect("Failed to parse hex");
        let signer = RadixSigner::new(priv_key_vec, "rdx".into()).expect("Failed to create signer");

        let provider_arc = Arc::new(provider);
        let adapter = build_adapter(provider_arc.clone(), signer.clone());

        let hash = H512::zero();
        let tx_status = adapter
            .get_tx_hash_status(hash)
            .await
            .expect("Failed to get tx hash status");

        assert_eq!(tx_status, TransactionStatus::Mempool);
    }

    #[tokio::test]
    async fn get_tx_hash_status_rejected() {
        let mut provider = MockRadixProvider::new();

        provider.expect_get_tx_hash_status().returning(|_| {
            Ok(TransactionStatusResponse {
                status: gateway_api_client::models::TransactionStatus::Rejected,
                ..Default::default()
            })
        });

        let priv_key_vec = hex::decode(TEST_PRIVATE_KEY).expect("Failed to parse hex");
        let signer = RadixSigner::new(priv_key_vec, "rdx".into()).expect("Failed to create signer");

        let provider_arc = Arc::new(provider);
        let adapter = build_adapter(provider_arc.clone(), signer.clone());

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
        let mut provider = MockRadixProvider::new();

        provider.expect_get_tx_hash_status().returning(|_| {
            Ok(TransactionStatusResponse {
                status: gateway_api_client::models::TransactionStatus::Unknown,
                ..Default::default()
            })
        });

        let priv_key_vec = hex::decode(TEST_PRIVATE_KEY).expect("Failed to parse hex");
        let signer = RadixSigner::new(priv_key_vec, "rdx".into()).expect("Failed to create signer");

        let provider_arc = Arc::new(provider);
        let adapter = build_adapter(provider_arc.clone(), signer.clone());

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
        let mut provider = MockRadixProvider::new();

        provider.expect_get_tx_hash_status().returning(|_| {
            Ok(TransactionStatusResponse {
                status: gateway_api_client::models::TransactionStatus::CommittedFailure,
                ..Default::default()
            })
        });

        let priv_key_vec = hex::decode(TEST_PRIVATE_KEY).expect("Failed to parse hex");
        let signer = RadixSigner::new(priv_key_vec, "rdx".into()).expect("Failed to create signer");

        let provider_arc = Arc::new(provider);
        let adapter = build_adapter(provider_arc.clone(), signer.clone());

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
        let mut provider = MockRadixProvider::new();

        provider.expect_get_tx_hash_status().returning(|_| {
            Ok(TransactionStatusResponse {
                status: gateway_api_client::models::TransactionStatus::CommittedSuccess,
                ..Default::default()
            })
        });

        let priv_key_vec = hex::decode(TEST_PRIVATE_KEY).expect("Failed to parse hex");
        let signer = RadixSigner::new(priv_key_vec, "rdx".into()).expect("Failed to create signer");

        let provider_arc = Arc::new(provider);
        let adapter = build_adapter(provider_arc.clone(), signer.clone());

        let hash = H512::zero();
        let tx_status = adapter
            .get_tx_hash_status(hash.clone())
            .await
            .expect("Failed to get tx hash status");

        assert_eq!(tx_status, TransactionStatus::Finalized);
    }
}
