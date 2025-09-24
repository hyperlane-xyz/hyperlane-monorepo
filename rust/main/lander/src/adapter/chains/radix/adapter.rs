use std::{str::FromStr, sync::Arc, time::Duration};

use core_api_client::models::FeeSummary;
use ethers::utils::hex;
use gateway_api_client::models::{CompiledPreviewTransaction, TransactionPreviewV2Request};
use hyperlane_core::{ChainCommunicationError, ChainResult, H256, H512};
use hyperlane_radix::{RadixProvider, RadixProviderForLander, RadixSigner, RadixTxCalldata};
use radix_common::{
    crypto::IsHash,
    math::{CheckedMul, Decimal, SaturatingAdd},
    prelude::{
        manifest_decode, AddressBech32Decoder, ManifestArgs, ManifestCustomValue, ManifestValue,
        NetworkDefinition,
    },
    types::ComponentAddress,
};
use radix_transactions::{
    model::{TransactionManifestV2, TransactionPayload},
    prelude::{
        DetailedNotarizedTransactionV2, ManifestBuilder, TransactionBuilder, TransactionV2Builder,
    },
    signing::{PrivateKey, Signer},
};
use scrypto::prelude::{ManifestCustomValueKind, ManifestValueKind};
use uuid::Uuid;

use crate::{
    adapter::{
        chains::radix::precursor::{Precursor, RadixTxPrecursor, VisibleComponents},
        AdaptsChain, GasLimit, TxBuildingResult,
    },
    payload::PayloadDetails,
    transaction::{Transaction, TransactionUuid, VmSpecificTxData},
    DispatcherMetrics, FullPayload, LanderError, TransactionDropReason, TransactionStatus,
};

// the number of simulate calls we do to get the necessary addresses
const NODE_DEPTH: usize = 5;

pub struct RadixAdapter {
    pub network: NetworkDefinition,
    pub provider: Arc<dyn RadixProviderForLander>,
    pub signer: RadixSigner,
    pub private_key: PrivateKey,
    pub component_regex: regex::Regex,
    pub estimated_block_time: Duration,
}

impl RadixAdapter {
    fn extract_tx_hash(tx: &DetailedNotarizedTransactionV2) -> H512 {
        let tx_hash: H512 =
            H256::from_slice(tx.transaction_hashes.transaction_intent_hash.0.as_bytes()).into();
        tx_hash
    }

    async fn visible_components(
        provider: &Arc<dyn RadixProviderForLander>,
        network: &NetworkDefinition,
        component_address: &str,
        method_name: &str,
        args: Vec<sbor::Value<ManifestCustomValueKind, ManifestCustomValue>>,
        component_regex: &regex::Regex,
    ) -> ChainResult<(Vec<ComponentAddress>, FeeSummary)> {
        let decoder = AddressBech32Decoder::new(network);
        let mut visible_components: Vec<ComponentAddress> = Vec::new();
        let mut fee_summary = FeeSummary::default();

        // in radix all addresses/node have to visible for a transaction to be valid
        // we simulate the tx first to get the necessary addresses
        for _ in 0..NODE_DEPTH {
            let manifest_args =
                Self::combine_args_with_visible_components(args.clone(), &visible_components);

            let tx_manifest = ManifestBuilder::new_v2()
                .call_method(component_address, method_name, manifest_args)
                .build();

            let tx = TransactionBuilder::new_v2()
                .manifest(tx_manifest)
                .build_preview_transaction(vec![])
                .to_raw()
                .map_err(|_| ChainCommunicationError::ParseError {
                    msg: "Failed to build tx".into(),
                })?;
            // we need to simulate the tx multiple times to get all the necessary addresses
            let result = provider
                .preview_tx(TransactionPreviewV2Request {
                    flags: Some(gateway_api_client::models::PreviewFlags {
                        use_free_credit: Some(true),
                        ..Default::default()
                    }),
                    preview_transaction: gateway_api_client::models::PreviewTransaction::Compiled(
                        CompiledPreviewTransaction {
                            preview_transaction_hex: hex::encode(tx),
                        },
                    ),
                    opt_ins: Some(gateway_api_client::models::TransactionPreviewV2OptIns {
                        core_api_receipt: Some(true),
                        ..Default::default()
                    }),
                })
                .await?;
            fee_summary = result.fee_summary;
            if result.status == core_api_client::models::TransactionStatus::Succeeded {
                break;
            }

            // luckily there is a fixed error message if a node is not visible
            // we match against that error message and extract the invisible component
            let error_message = result.error_message.unwrap_or_default();
            if let Some(matched) = component_regex.find(&error_message) {
                if let Some(component_address) =
                    ComponentAddress::try_from_bech32(&decoder, matched.as_str())
                {
                    visible_components.push(component_address);
                }
            } else {
                // early return if the error message is caused by something else than an invisible node
                return Ok((visible_components, fee_summary));
            }
        }

        Ok((visible_components, fee_summary))
    }

    fn combine_args_with_visible_components(
        mut manifest_values: Vec<sbor::Value<ManifestCustomValueKind, ManifestCustomValue>>,
        visible_components: &[ComponentAddress],
    ) -> ManifestArgs {
        let visible_components_sbor: Vec<_> = visible_components
            .iter()
            .map(|v| sbor::Value::Custom {
                value: ManifestCustomValue::Address(v.clone().into()),
            })
            .collect();
        manifest_values.push(ManifestValue::Array {
            element_value_kind: sbor::ValueKind::Custom(
                scrypto::prelude::ManifestCustomValueKind::Address,
            ),
            // expected struct `Vec<SborValue<ManifestCustomValueKind, ManifestCustomValue>>`
            elements: visible_components_sbor,
        });
        ManifestArgs::new_from_tuple_or_panic(ManifestValue::Tuple {
            fields: manifest_values,
        })
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

    async fn simulate_tx(&self, tx: &mut Transaction) -> Result<Vec<PayloadDetails>, LanderError> {
        tracing::info!(?tx, "simulating transaction");

        let (visible_components, fee_summary) = {
            let tx_precursor = tx.precursor();
            // decode manifest value from Mailbox::process_calldata()
            let manifest_value: ManifestValue = manifest_decode(&tx_precursor.encoded_arguments)
                .map_err(|_| LanderError::PayloadNotFound)?;

            let manifest_args = match manifest_value {
                sbor::Value::Tuple { fields } => fields,
                _ => vec![],
            };
            Self::visible_components(
                &self.provider,
                &self.network,
                &tx_precursor.component_address,
                &tx_precursor.method_name,
                manifest_args,
                &self.component_regex,
            )
            .await?
        };

        let precursor = tx.precursor_mut();

        precursor.fee_summary = Some(fee_summary);
        precursor.visible_components = Some(VisibleComponents {
            addresses: visible_components.iter().map(|v| v.to_hex()).collect(),
        });
        Ok(Vec::new())
    }

    async fn estimate_tx(&self, tx: &mut Transaction) -> Result<(), LanderError> {
        self.simulate_tx(tx).await?;
        Ok(())
    }

    async fn submit(&self, tx: &mut Transaction) -> Result<(), LanderError> {
        tracing::info!(?tx, "submitting transaction");

        let tx_precursor = tx.precursor_mut();

        let fee_summary = match tx_precursor.fee_summary.clone() {
            Some(s) => s,
            None => return Err(LanderError::EstimationFailed),
        };
        let component_address = tx_precursor.component_address.clone();
        let method_name = tx_precursor.method_name.clone();

        let visible_components: Vec<ComponentAddress> =
            match tx_precursor.visible_components.as_ref() {
                Some(v) => v
                    .addresses
                    .iter()
                    .filter_map(|s| ComponentAddress::try_from_hex(s))
                    .collect(),
                None => return Err(LanderError::EstimationFailed),
            };

        // decode manifest value from Mailbox::process_calldata()
        let manifest_value: ManifestValue = manifest_decode(&tx_precursor.encoded_arguments)
            .map_err(|_| LanderError::PayloadNotFound)?;
        let manifest_values = match manifest_value {
            // Should always be a tuple
            sbor::Value::Tuple { fields } => fields,
            sbor::Value::Array { elements, .. } => elements,
            _ => vec![],
        };
        let manifest_args =
            Self::combine_args_with_visible_components(manifest_values, &visible_components);

        // 1.5x multiplier to fee summary
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
                    .call_method(component_address, method_name, manifest_args)
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
        &self.estimated_block_time
    }

    fn max_batch_size(&self) -> u32 {
        // currently not supported on radix because it will make
        // it hard to track transaction sender and recipient
        1
    }

    fn update_vm_specific_metrics(&self, _tx: &Transaction, _metrics: &DispatcherMetrics) {}

    async fn nonce_gap_exists(&self) -> bool {
        false
    }

    async fn replace_tx(&self, _tx: &Transaction) -> Result<(), LanderError> {
        Ok(())
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

        let priv_key_vec = hex::decode(PRIVATE_KEY).expect("Failed to parse hex");
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

        let priv_key_vec = hex::decode(PRIVATE_KEY).expect("Failed to parse hex");
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

        let priv_key_vec = hex::decode(PRIVATE_KEY).expect("Failed to parse hex");
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

        let priv_key_vec = hex::decode(PRIVATE_KEY).expect("Failed to parse hex");
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

        let priv_key_vec = hex::decode(PRIVATE_KEY).expect("Failed to parse hex");
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
