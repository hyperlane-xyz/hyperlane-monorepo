#[cfg(test)]
pub mod tests;

use std::{str::FromStr, sync::Arc, time::Duration};

use core_api_client::models::FeeSummary;
use ethers::utils::hex;
use futures_util::TryFutureExt;
use gateway_api_client::models::{CompiledPreviewTransaction, TransactionPreviewV2Request};
use radix_transactions::{
    model::{IntentHeaderV2, TransactionHeaderV2, TransactionPayload},
    prelude::{
        DetailedNotarizedTransactionV2, ManifestBuilder, TransactionBuilder, TransactionV2Builder,
    },
    signing::PrivateKey,
};
use scrypto::{
    address::{AddressBech32Decoder, AddressBech32Encoder},
    crypto::IsHash,
    math::{CheckedMul, Decimal, SaturatingAdd},
    network::NetworkDefinition,
    prelude::{
        manifest_decode, ManifestArgs, ManifestCustomValue, ManifestCustomValueKind, ManifestValue,
    },
    types::{ComponentAddress, Epoch},
};

use hyperlane_base::{settings::ChainConf, CoreMetrics};
use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, ReorgPeriod, H256, H512,
};
use hyperlane_radix::{RadixProvider, RadixProviderForLander, RadixSigner, RadixTxCalldata};

use crate::adapter::chains::radix::transaction::{Precursor, TransactionFactory};
use crate::{
    adapter::{
        chains::radix::{conf::create_signer, VisibleComponents},
        AdaptsChain, GasLimit, RadixTxPrecursor, TxBuildingResult,
    },
    payload::PayloadDetails,
    transaction::Transaction,
    DispatcherMetrics, FullPayload, LanderError, TransactionDropReason, TransactionStatus,
};

// the number of simulate calls we do to get the necessary addresses
const NODE_DEPTH: usize = 5;
const GAS_MULTIPLIER: &str = "1.5";

pub struct RadixAdapter {
    pub network: NetworkDefinition,
    pub provider: Arc<dyn RadixProviderForLander>,
    pub signer: RadixSigner,
    pub component_regex: regex::Regex,
    pub estimated_block_time: Duration,
}

#[derive(Clone)]
pub struct RadixTxBuilder {
    pub tx_builder: TransactionV2Builder,
    pub signer: RadixSigner,
}

impl RadixAdapter {
    pub fn from_conf(
        conf: &ChainConf,
        metrics: &CoreMetrics,
        connection_conf: &hyperlane_radix::ConnectionConf,
    ) -> Result<Self, LanderError> {
        // We must have a signer if we want to land transactions.
        let signer = create_signer(conf)?;

        let locator = ContractLocator {
            domain: &conf.domain,
            address: H256::zero(),
        };

        let chain_info = conf.metrics_conf().chain;
        let client_metrics = metrics.client_metrics();

        let provider = RadixProvider::new(
            Some(signer.clone()),
            connection_conf,
            &locator,
            &conf.reorg_period,
            client_metrics,
            chain_info,
        )?;

        let network = connection_conf.network.clone();
        let component_regex =
            regex::Regex::new(&format!(r"\w+_{}([a-zA-Z0-9]+)", network.hrp_suffix))
                .map_err(ChainCommunicationError::from_other)?;
        Ok(Self {
            network,
            provider: Arc::new(provider),
            signer,
            component_regex,
            estimated_block_time: conf.estimated_block_time,
        })
    }

    fn extract_tx_hash(tx: &DetailedNotarizedTransactionV2) -> H512 {
        // transaction_intent_hash basically is the TX Hash and
        // refers to all of the intents that are made in the TX
        let tx_hash: H512 =
            H256::from_slice(tx.transaction_hashes.transaction_intent_hash.0.as_bytes()).into();
        tx_hash
    }

    async fn tx_builder(&self, intent_discriminator: u64) -> ChainResult<RadixTxBuilder> {
        let epoch = self.provider.get_gateway_status().await?.ledger_state.epoch as u64;

        let private_key = self.signer.get_signer()?;
        let tx_builder = TransactionBuilder::new_v2()
            .transaction_header(TransactionHeaderV2 {
                notary_public_key: private_key.public_key(),
                notary_is_signatory: true,
                tip_basis_points: 0u32, // TODO: what should we set this to?
            })
            .intent_header(IntentHeaderV2 {
                network_id: self.network.id,
                start_epoch_inclusive: Epoch::of(epoch),
                end_epoch_exclusive: Epoch::of(epoch.saturating_add(2)), // ~5 minutes per epoch -> 10min timeout
                intent_discriminator,
                min_proposer_timestamp_inclusive: None, // TODO: discuss whether or not we want to have a time limit
                max_proposer_timestamp_exclusive: None,
            });
        Ok(RadixTxBuilder {
            tx_builder,
            signer: self.signer.clone(),
        })
    }

    /// gets all addresses associated with a tx
    async fn visible_components(
        &self,
        component_address: &ComponentAddress,
        method_name: &str,
        args: Vec<sbor::Value<ManifestCustomValueKind, ManifestCustomValue>>,
    ) -> ChainResult<(Vec<ComponentAddress>, FeeSummary)> {
        let decoder = AddressBech32Decoder::new(&self.network);

        let mut last_simulated_status = core_api_client::models::TransactionStatus::Failed;
        let mut visible_components: Vec<ComponentAddress> = Vec::new();
        let mut fee_summary = FeeSummary::default();

        let intent_discriminator = rand::random::<u64>();
        let RadixTxBuilder { tx_builder, .. } = self.tx_builder(intent_discriminator).await?;

        // in radix all addresses/node have to visible for a transaction to be valid
        // we simulate the tx first to get the necessary addresses
        for _ in 0..NODE_DEPTH {
            let manifest_args =
                Self::combine_args_with_visible_components(args.clone(), &visible_components);

            let tx_manifest = ManifestBuilder::new_v2()
                .call_method(*component_address, method_name, manifest_args)
                .build();

            let tx = tx_builder
                .clone()
                .manifest(tx_manifest)
                .build_preview_transaction(vec![])
                .to_raw()
                .map_err(|_| ChainCommunicationError::ParseError {
                    msg: "Failed to build tx".into(),
                })?;
            // we need to simulate the tx multiple times to get all the necessary addresses
            let result = self
                .provider
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
            last_simulated_status = result.status;
            if last_simulated_status == core_api_client::models::TransactionStatus::Succeeded {
                break;
            }

            // luckily there is a fixed error message if a node is not visible
            // we match against that error message and extract the invisible component
            let error_message = result.error_message.unwrap_or_default();
            if let Some(matched) = self.component_regex.find(&error_message) {
                if let Some(component_address) =
                    ComponentAddress::try_from_bech32(&decoder, matched.as_str())
                {
                    visible_components.push(component_address);
                }
            } else {
                // early return if the error message is caused by something else than an invisible node
                return Err(ChainCommunicationError::SimulationFailed(error_message));
            }
        }

        if last_simulated_status != core_api_client::models::TransactionStatus::Succeeded {
            return Err(ChainCommunicationError::SimulationFailed(
                "NODE_DEPTH reached".into(),
            ));
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
                value: ManifestCustomValue::Address((*v).into()),
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

    async fn build_transaction(
        &self,
        tx: &Transaction,
        intent_discriminator: u64,
    ) -> Result<DetailedNotarizedTransactionV2, LanderError> {
        let tx_precursor = tx.precursor();

        let fee_summary = match tx_precursor.fee_summary.clone() {
            Some(s) => s,
            None => return Err(LanderError::EstimationFailed),
        };
        let decoder = AddressBech32Decoder::new(&self.network);
        let component_address =
            ComponentAddress::try_from_bech32(&decoder, &tx_precursor.component_address)
                .ok_or_else(|| {
                    let error_msg = "Failed to parse ComponentAddress";
                    tracing::error!(
                        component_address = tx_precursor.component_address,
                        "{error_msg}"
                    );
                    LanderError::PayloadNotFound
                })?;

        let method_name = tx_precursor.method_name.clone();
        let visible_components: Vec<ComponentAddress> =
            match tx_precursor.visible_components.as_ref() {
                Some(v) => v
                    .addresses
                    .iter()
                    .filter_map(|s| ComponentAddress::try_from_bech32(&decoder, s))
                    .collect(),
                None => return Err(LanderError::EstimationFailed),
            };

        // decode manifest value from Mailbox::process_calldata()
        let manifest_value: ManifestValue = manifest_decode(&tx_precursor.encoded_arguments)
            .map_err(|_| LanderError::PayloadNotFound)?;
        let manifest_values = match manifest_value {
            // Should always be a tuple, but mirror simulate_tx for safety
            sbor::Value::Tuple { fields } => fields,
            s => vec![s],
        };
        let manifest_args =
            Self::combine_args_with_visible_components(manifest_values, &visible_components);

        // 1.5x multiplier to fee summary
        let multiplier = Decimal::from_str(GAS_MULTIPLIER).expect("Failed to parse GAS_MULTIPLIER");
        let simulated_xrd = RadixProvider::total_fee(fee_summary)?
            .checked_mul(multiplier)
            .ok_or_else(|| LanderError::EstimationFailed)?;

        tracing::debug!("simulated_xrd: {:?}", simulated_xrd);

        let RadixTxBuilder { tx_builder, signer } = self.tx_builder(intent_discriminator).await?;
        let private_key = signer.get_signer()?;
        let radix_tx = tx_builder
            .manifest_builder(|builder| {
                builder.lock_fee(signer.address, simulated_xrd).call_method(
                    component_address,
                    method_name,
                    manifest_args,
                )
            })
            .notarize(&private_key)
            .build();

        Ok(radix_tx)
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
            let tx = TransactionFactory::build(precursor, full_payload);

            build_txs.push(TxBuildingResult {
                payloads: vec![full_payload.details.clone()],
                maybe_tx: Some(tx),
            });
        }
        build_txs
    }

    async fn simulate_tx(&self, tx: &mut Transaction) -> Result<Vec<PayloadDetails>, LanderError> {
        tracing::info!(?tx, "simulating transaction");

        let (visible_components, fee_summary) = {
            let tx_precursor = tx.precursor();
            // decode arguments
            let manifest_value: ManifestValue = manifest_decode(&tx_precursor.encoded_arguments)
                .map_err(|err| {
                    let error_msg = "Failed to decode manifest";
                    tracing::error!(?err, "{error_msg}");
                    LanderError::PayloadNotFound
                })?;

            let manifest_args = match manifest_value {
                sbor::Value::Tuple { fields } => fields,
                s => vec![s],
            };

            let decoder = AddressBech32Decoder::new(&self.network);
            let component_address =
                ComponentAddress::try_from_bech32(&decoder, &tx_precursor.component_address)
                    .ok_or_else(|| {
                        let error_msg = "Failed to parse ComponentAddress";
                        tracing::error!(
                            component_address = tx_precursor.component_address,
                            "{error_msg}"
                        );
                        LanderError::PayloadNotFound
                    })?;
            match self
                .visible_components(&component_address, &tx_precursor.method_name, manifest_args)
                .await
            {
                Ok(s) => s,
                Err(err) => {
                    tracing::error!(?err, "Failed to get visible components");
                    return Ok(tx.payload_details.clone());
                }
            }
        };

        let encoder = AddressBech32Encoder::new(&self.network);
        let precursor = tx.precursor_mut();

        precursor.fee_summary = Some(fee_summary);
        precursor.visible_components = Some(VisibleComponents {
            addresses: visible_components
                .iter()
                .filter_map(|v| encoder.encode(v.as_bytes()).ok())
                .collect(),
        });
        Ok(Vec::new())
    }

    async fn estimate_tx(&self, _tx: &mut Transaction) -> Result<(), LanderError> {
        Ok(())
    }

    async fn submit(&self, tx: &mut Transaction) -> Result<(), LanderError> {
        tracing::info!(?tx, "submitting transaction");

        // derive a stable discriminator from the tx UUID to keep hashes reproducible
        let intent_discriminator = {
            let b = tx.uuid.as_bytes();
            u64::from_le_bytes(b[0..8].try_into().expect("uuid is 16 bytes"))
        };
        let radix_tx = self.build_transaction(tx, intent_discriminator).await?;
        self.provider
            .send_transaction(radix_tx.raw.clone().to_vec())
            .await?;

        // once tx is built, we can figure out tx hash
        let tx_hash = Self::extract_tx_hash(&radix_tx);
        if !tx.tx_hashes.contains(&tx_hash) {
            tx.tx_hashes.push(tx_hash);
        }
        let tx_precursor = tx.precursor_mut();
        tx_precursor.tx_hash = Some(tx_hash);

        tracing::info!(tx_uuid=?tx.uuid, ?tx_hash, "submitted transaction");
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
                Err(LanderError::TxHashNotFound(format!("{hash:x}")))
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
