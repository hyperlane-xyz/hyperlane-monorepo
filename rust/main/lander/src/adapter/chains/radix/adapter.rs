use std::{str::FromStr, sync::Arc, time::Duration};

use hyperlane_core::{H256, H512};
use hyperlane_radix::{
    RadixDeliveredCalldata, RadixProcessCalldata, RadixProvider, RadixProviderForLander,
    RadixSigner,
};
use radix_common::{
    crypto::IsHash,
    math::{CheckedMul, Decimal, SaturatingAdd},
    prelude::{manifest_decode, ManifestArgs, ManifestValue},
};
use radix_transactions::{
    model::TransactionManifestV2,
    prelude::{DetailedNotarizedTransactionV2, ManifestBuilder, TransactionBuilder},
    signing::{PrivateKey, Signer},
};
use uuid::Uuid;

use crate::{
    adapter::{
        chains::radix::precursor::{Precursor, RadixTxPrecursor},
        AdaptsChain, GasLimit, TxBuildingResult,
    },
    payload::PayloadDetails,
    transaction::{Transaction, TransactionUuid, VmSpecificTxData},
    DispatcherMetrics, FullPayload, LanderError, TransactionDropReason, TransactionStatus,
};

pub struct RadixAdapter {
    pub provider: Arc<dyn RadixProviderForLander>,
    pub signer: RadixSigner,
    pub private_key: PrivateKey,
}

impl RadixAdapter {
    fn extract_tx_hash(tx: &DetailedNotarizedTransactionV2) -> H512 {
        let tx_hash: H512 =
            H256::from_slice(tx.transaction_hashes.transaction_intent_hash.0.as_bytes()).into();
        tx_hash
    }
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

    async fn submit(&self, tx: &mut Transaction) -> Result<(), LanderError> {
        tracing::info!(?tx, "submitting transaction");

        let tx_precursor = tx.precursor_mut();

        let fee_summary = tx_precursor.fee_summary.clone();
        let component_address = tx_precursor.component_address.clone();
        let method_name = tx_precursor.method_name.clone();

        // decode manifest value from Mailbox::process_calldata()
        let manifest_args: ManifestValue = manifest_decode(&tx_precursor.encoded_arguments)
            .map_err(|_| LanderError::PayloadNotFound)?;

        // 1.5x multipler to fee summary
        let multiplier = Decimal::ONE
            .saturating_add(Decimal::ONE_TENTH)
            .saturating_add(Decimal::ONE_TENTH)
            .saturating_add(Decimal::ONE_TENTH)
            .saturating_add(Decimal::ONE_TENTH)
            .saturating_add(Decimal::ONE_TENTH);

        let simulated_xrd = RadixProvider::total_fee(fee_summary)?
            .checked_mul(multiplier)
            .ok_or_else(|| LanderError::EstimationFailed)?;

        let radix_tx = TransactionBuilder::new_v2()
            .manifest_builder(|builder| {
                builder
                    .call_method_raw(component_address, method_name, manifest_args)
                    .lock_fee(self.signer.address, simulated_xrd)
            })
            .sign(&self.private_key)
            .notarize(&self.private_key)
            .build();

        // once tx is built, we can figure out tx hash
        let tx_hash = Self::extract_tx_hash(&radix_tx);
        tx_precursor.tx_hash = Some(tx_hash);
        if !tx.tx_hashes.contains(&tx_hash) {
            tx.tx_hashes.push(tx_hash);
        }

        self.provider
            .send_transaction(radix_tx.raw.clone().to_vec())
            .await?;

        tracing::info!(?tx, ?radix_tx, ?tx_hash, "submitted transaction");

        Ok(())
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
        let delivered_calldata_list: Vec<(RadixDeliveredCalldata, &PayloadDetails)> = tx
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

    const PRIVATE_KEY: &str = "E99BC4A79BCE79A990322FBE97E2CEFF85C5DB7B39C495215B6E2C7020FD103D";

    #[tokio::test]
    async fn get_tx_hash_status_pending() {
        let mut provider = MockRadixProvider::new();

        provider.expect_get_tx_hash_status().returning(|_| {
            Ok(TransactionStatusResponse {
                status: gateway_api_client::models::TransactionStatus::Pending,
                ..Default::default()
            })
        });

        let priv_key_vec = hex::decode(PRIVATE_KEY).expect("Failed to parse hex");
        let signer = RadixSigner::new(priv_key_vec, "rdx".into()).expect("Failed to create signer");

        let private_key = signer.get_signer().expect("Failed to get private key");
        let adapter = RadixAdapter {
            provider: Arc::new(provider),
            private_key,
            signer,
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
        let mut provider = MockRadixProvider::new();

        provider.expect_get_tx_hash_status().returning(|_| {
            Ok(TransactionStatusResponse {
                status: gateway_api_client::models::TransactionStatus::Rejected,
                ..Default::default()
            })
        });

        let priv_key_vec = hex::decode(PRIVATE_KEY).expect("Failed to parse hex");
        let signer = RadixSigner::new(priv_key_vec, "rdx".into()).expect("Failed to create signer");

        let private_key = signer.get_signer().expect("Failed to get private key");
        let adapter = RadixAdapter {
            provider: Arc::new(provider),
            private_key,
            signer,
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
        let mut provider = MockRadixProvider::new();

        provider.expect_get_tx_hash_status().returning(|_| {
            Ok(TransactionStatusResponse {
                status: gateway_api_client::models::TransactionStatus::Unknown,
                ..Default::default()
            })
        });

        let priv_key_vec = hex::decode(PRIVATE_KEY).expect("Failed to parse hex");
        let signer = RadixSigner::new(priv_key_vec, "rdx".into()).expect("Failed to create signer");

        let private_key = signer.get_signer().expect("Failed to get private key");
        let adapter = RadixAdapter {
            provider: Arc::new(provider),
            private_key,
            signer,
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
        let mut provider = MockRadixProvider::new();

        provider.expect_get_tx_hash_status().returning(|_| {
            Ok(TransactionStatusResponse {
                status: gateway_api_client::models::TransactionStatus::CommittedFailure,
                ..Default::default()
            })
        });

        let priv_key_vec = hex::decode(PRIVATE_KEY).expect("Failed to parse hex");
        let signer = RadixSigner::new(priv_key_vec, "rdx".into()).expect("Failed to create signer");

        let private_key = signer.get_signer().expect("Failed to get private key");
        let adapter = RadixAdapter {
            provider: Arc::new(provider),
            private_key,
            signer,
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
        let mut provider = MockRadixProvider::new();

        provider.expect_get_tx_hash_status().returning(|_| {
            Ok(TransactionStatusResponse {
                status: gateway_api_client::models::TransactionStatus::CommittedSuccess,
                ..Default::default()
            })
        });

        let priv_key_vec = hex::decode(PRIVATE_KEY).expect("Failed to parse hex");
        let signer = RadixSigner::new(priv_key_vec, "rdx".into()).expect("Failed to create signer");

        let private_key = signer.get_signer().expect("Failed to get private key");
        let adapter = RadixAdapter {
            provider: Arc::new(provider),
            private_key,
            signer,
        };

        let hash = H512::zero();
        let tx_status = adapter
            .get_tx_hash_status(hash.clone())
            .await
            .expect("Failed to get tx hash status");

        assert_eq!(tx_status, TransactionStatus::Finalized);
    }
}
