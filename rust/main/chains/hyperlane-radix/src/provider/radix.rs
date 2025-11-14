use std::{
    ops::{Deref, RangeInclusive},
    str::FromStr,
    time::Duration,
};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use core_api_client::{
    apis::configuration::Configuration as CoreConfig,
    models::{
        ComponentMethodTargetIdentifier, EventEmitterIdentifier, FeeSummary, TargetIdentifier,
        TransactionCallPreviewRequest, TransactionReceipt, TransactionStatus,
        VersionLedgerStateSelector,
    },
};
use gateway_api_client::{
    apis::configuration::Configuration as GatewayConfig,
    models::{
        self, CommittedTransactionInfo, CompiledPreviewTransaction, LedgerStateSelector,
        ProgrammaticScryptoSborValue, StreamTransactionsRequest,
        TransactionCommittedDetailsRequest, TransactionDetailsOptIns, TransactionPreviewV2Request,
        TransactionStatusResponse,
    },
};
use hyperlane_metric::prometheus_metric::{ChainInfo, PrometheusClientMetrics};
use radix_common::traits::ScryptoEvent;
use radix_transactions::{
    builder::{
        ManifestBuilder, TransactionBuilder, TransactionManifestV2Builder, TransactionV2Builder,
    },
    model::{IntentHeaderV2, TransactionHeaderV2, TransactionPayload},
    prelude::DetailedNotarizedTransactionV2,
    signing::PrivateKey,
};
use reqwest::Client;
use reqwest_utils::parse_custom_rpc_headers;
use scrypto::{
    address::AddressBech32Decoder,
    constants::XRD,
    crypto::IsHash,
    data::{
        manifest::{manifest_encode, ManifestEncode},
        scrypto::{scrypto_decode, ScryptoSbor},
    },
    math::Decimal,
    network::NetworkDefinition,
    types::Epoch,
};

use hyperlane_core::{
    rpc_clients::FallbackProvider, BlockInfo, ChainCommunicationError, ChainResult,
    ContractLocator, Encode, HyperlaneChain, HyperlaneDomain, HyperlaneProvider, LogMeta,
    ReorgPeriod, TxOutcome, TxnInfo, TxnReceiptInfo, H256, H512, U256,
};
use serde::{Deserialize, Serialize};

use crate::{
    decimal_to_u256, decode_bech32, encode_tx,
    manifest::find_fee_payer_from_manifest,
    provider::{
        metric::{RadixMetricCoreProvider, RadixMetricGatewayProvider},
        RadixGatewayProvider,
    },
    radix_address_bytes_to_h256,
    signer::RadixSigner,
    ConnectionConf, HyperlaneRadixError, RadixBaseCoreProvider, RadixBaseGatewayProvider,
    RadixCoreProvider, RadixFallbackProvider,
};

/// Radix provider
#[derive(Debug, Clone)]
pub struct RadixProvider {
    provider: RadixFallbackProvider,
    signer: Option<RadixSigner>,
    conf: ConnectionConf,
    domain: HyperlaneDomain,
    reorg: ReorgPeriod,
}

impl Deref for RadixProvider {
    type Target = RadixFallbackProvider;

    fn deref(&self) -> &Self::Target {
        &self.provider
    }
}

impl RadixProvider {
    fn build_fallback_provider(
        conf: &ConnectionConf,
        metrics: PrometheusClientMetrics,
        chain: Option<ChainInfo>,
    ) -> ChainResult<RadixFallbackProvider> {
        let mut gateway_provider = Vec::with_capacity(conf.gateway.len());
        for url in conf.gateway.iter() {
            let (headers, url) =
                parse_custom_rpc_headers(url).map_err(ChainCommunicationError::from_other)?;
            let client = Client::builder()
                .default_headers(headers)
                .build()
                .map_err(HyperlaneRadixError::from)?;
            let provider = RadixBaseGatewayProvider::new(GatewayConfig {
                client,
                base_path: url.to_string().trim_end_matches('/').to_string(),
                ..Default::default()
            });
            let provider =
                RadixMetricGatewayProvider::new(provider, &url, metrics.clone(), chain.clone());
            gateway_provider.push(provider);
        }

        let mut core_provider = Vec::with_capacity(conf.core.len());
        for url in conf.core.iter() {
            let (headers, url) =
                parse_custom_rpc_headers(url).map_err(ChainCommunicationError::from_other)?;
            let client = Client::builder()
                .default_headers(headers)
                .build()
                .map_err(HyperlaneRadixError::from)?;
            let provider = RadixBaseCoreProvider::new(
                CoreConfig {
                    client,
                    base_path: url.to_string().trim_end_matches('/').to_string(),
                    ..Default::default()
                },
                conf.network.clone(),
            );
            let provider =
                RadixMetricCoreProvider::new(provider, &url, metrics.clone(), chain.clone());
            core_provider.push(provider);
        }
        Ok(RadixFallbackProvider::new(
            FallbackProvider::new(core_provider),
            FallbackProvider::new(gateway_provider),
        ))
    }

    /// Create a new Radix Provider
    pub fn new(
        signer: Option<RadixSigner>,
        conf: &ConnectionConf,
        locator: &ContractLocator,
        reorg: &ReorgPeriod,
        metrics: PrometheusClientMetrics,
        chain: Option<ChainInfo>,
    ) -> ChainResult<RadixProvider> {
        Ok(Self {
            domain: locator.domain.clone(),
            signer,
            reorg: reorg.clone(),
            provider: Self::build_fallback_provider(conf, metrics, chain)?,
            conf: conf.clone(),
        })
    }

    /// Get the Radix Signer
    pub fn get_signer(&self) -> ChainResult<&RadixSigner> {
        let signer = self
            .signer
            .as_ref()
            .ok_or(HyperlaneRadixError::SignerMissing)?;
        Ok(signer)
    }

    /// Calls a method on a component at a specific block
    pub async fn call_method_at_state<T: ScryptoSbor>(
        &self,
        component: &str,
        method: &str,
        state_version: Option<u64>,
        raw_args: Vec<Vec<u8>>,
    ) -> ChainResult<(T, u64)> {
        let selector = state_version.map(|state_version| {
            core_api_client::models::LedgerStateSelector::ByStateVersion(
                VersionLedgerStateSelector { state_version },
            )
        });

        let args = raw_args.into_iter().map(hex::encode).collect();

        let result = self
            .provider
            .call_preview(TransactionCallPreviewRequest {
                arguments: args,
                at_ledger_state: selector,
                target: TargetIdentifier::Method(ComponentMethodTargetIdentifier {
                    component_address: component.to_owned(),
                    method_name: method.to_owned(),
                }),
                network: self.conf.network.logical_name.to_string(),
            })
            .await?;
        match result.status {
            TransactionStatus::Succeeded => {
                if let Some(output) = result.output {
                    let Some(data) = output.hex else {
                        return Err(
                            HyperlaneRadixError::SborCallMethod("no output found".into()).into(),
                        );
                    };
                    let data = hex::decode(data)?;
                    return Ok((
                        scrypto_decode::<T>(&data).map_err(HyperlaneRadixError::from)?,
                        result.at_ledger_state.state_version,
                    ));
                }
                Err(HyperlaneRadixError::SborCallMethod("no output found".into()).into())
            }
            _ => Err(HyperlaneRadixError::SborCallMethod(format!(
                "status: {} error: {:?}",
                result.status, result.error_message
            ))
            .into()),
        }
    }

    /// Calls a method on a component
    pub async fn call_method<T: ScryptoSbor>(
        &self,
        component: &str,
        method: &str,
        reorg: Option<&ReorgPeriod>,
        raw_args: Vec<Vec<u8>>,
    ) -> ChainResult<(T, u64)> {
        let state_version = match reorg {
            Some(ReorgPeriod::None) => None,
            Some(reorg) => Some(self.get_state_version(Some(reorg)).await?),
            None => None,
        };

        self.call_method_at_state(component, method, state_version, raw_args)
            .await
    }

    /// Calls a method with arguments on a component
    pub async fn call_method_with_arg<T: ScryptoSbor, A: ManifestEncode + ?Sized>(
        &self,
        component: &str,
        method: &str,
        argument: &A,
    ) -> ChainResult<T> {
        let arguments = manifest_encode(argument).map_err(HyperlaneRadixError::from)?;

        Ok(self
            .call_method::<T>(component, method, None, vec![arguments])
            .await?
            .0)
    }

    /// Returns the latest ledger state of the chain
    pub async fn get_state_version(&self, reorg: Option<&ReorgPeriod>) -> ChainResult<u64> {
        let status = self.core_status().await?;
        let state = status.current_state_identifier.state_version;
        let reorg = reorg.unwrap_or(&self.reorg);
        let offset = match reorg {
            ReorgPeriod::None => 0,
            ReorgPeriod::Blocks(blocks) => blocks.get(),
            ReorgPeriod::Tag(_) => {
                return Err(HyperlaneRadixError::Other(
                    "radix only supports blocks as reorg periods".to_owned(),
                )
                .into())
            }
        };
        Ok(state.saturating_sub(offset as u64))
    }

    fn filter_parsed_logs<T: ScryptoEvent>(
        contract: &str,
        txs: Vec<CommittedTransactionInfo>,
        parse: fn(ProgrammaticScryptoSborValue) -> ChainResult<T>,
    ) -> ChainResult<Vec<(T, LogMeta)>> {
        let mut events = vec![];

        for tx in txs {
            let Some(receipt) = tx.receipt else {
                return Err(HyperlaneRadixError::ParsingError("receipt".to_owned()).into());
            };

            // filter out failed transactions
            if receipt.status != Some(models::TransactionStatus::CommittedSuccess) {
                continue;
            }

            let Some(hash) = tx.intent_hash else {
                return Err(HyperlaneRadixError::ParsingError(
                    "failed to parse intent hash".to_owned(),
                )
                .into());
            };
            let (_, hash) = bech32::decode(&hash).map_err(HyperlaneRadixError::from)?;
            let hash = H256::from_slice(&hash);
            let Some(raw_events) = receipt.events else {
                return Err(
                    HyperlaneRadixError::ParsingError("events not present".to_owned()).into(),
                );
            };

            for (event_index, event) in raw_events.iter().enumerate() {
                // make sure to return only events that match the params
                if event.name != T::EVENT_NAME {
                    continue;
                }
                let emitter: EventEmitterIdentifier = serde_json::from_value(event.emitter.clone())
                    .map_err(HyperlaneRadixError::from)?;
                match emitter {
                    EventEmitterIdentifier::Method(method)
                        if method.entity.entity_address == contract =>
                    {
                        let address = decode_bech32(&method.entity.entity_address)?;

                        // Pad address to 32 bytes with zeros
                        let mut padded_address = [0u8; 32];
                        let len = std::cmp::min(address.len(), 32);
                        padded_address[32 - len..].copy_from_slice(&address[..len]);
                        let address: H256 = padded_address.into();

                        let height = U256::from(tx.state_version as u64).to_vec();

                        let meta = LogMeta {
                            address,
                            block_number: tx.state_version.try_into()?,
                            block_hash: H256::from_slice(&height),
                            transaction_id: hash.into(),
                            transaction_index: tx.state_version.try_into()?, // the state version is the absolute identifier for a transaction
                            log_index: event_index.into(),
                        };

                        events.push((event.data.clone(), meta))
                    }
                    _ => continue,
                }
            }
        }

        events
            .into_iter()
            .map(|(event, meta)| parse(event).map(|x| (x, meta)))
            .collect::<Result<Vec<_>, _>>()
    }

    /// Fetches events for a tx that were emitted from the given contract
    pub async fn fetch_logs_by_hash<T: ScryptoEvent>(
        &self,
        contract: &str,
        hash: &H512,
        parse: fn(ProgrammaticScryptoSborValue) -> ChainResult<T>,
    ) -> ChainResult<Vec<(T, LogMeta)>> {
        let tx = self.get_tx_by_hash(hash).await?;
        Self::filter_parsed_logs(contract, vec![tx], parse)
    }

    /// Fetches events for a range of state versions that were emitted from the given contract
    pub async fn fetch_logs_in_range<T: ScryptoEvent>(
        &self,
        contract: &str,
        range: RangeInclusive<u32>,
        parse: fn(ProgrammaticScryptoSborValue) -> ChainResult<T>,
    ) -> ChainResult<Vec<(T, LogMeta)>> {
        let txs = self
            .get_raw_txs(*range.start() as u64, *range.end() as u64, Some(contract))
            .await?;

        Self::filter_parsed_logs(contract, txs, parse)
    }

    /// Returns a raw radix transaction
    /// instead of fetching the txs for each individual state_version
    /// we start a search at the beginning state version with the corresponding filters
    /// this improves the performance as there are probably very little to no relevant transactions in the given sv range
    pub async fn get_tx_by_hash(&self, hash: &H512) -> ChainResult<CommittedTransactionInfo> {
        let hash: H256 = (*hash).into();
        let hash = encode_tx(&self.conf.network, hash)?;
        let response = self
            .transaction_committed(TransactionCommittedDetailsRequest {
                intent_hash: hash,
                opt_ins: Some(TransactionDetailsOptIns {
                    affected_global_entities: Some(true),
                    manifest_instructions: Some(true),
                    receipt_events: Some(true),
                    receipt_fee_summary: Some(true),
                    receipt_state_changes: Some(true),
                    ..Default::default()
                }),
                ..Default::default()
            })
            .await?;
        Ok(response)
    }

    /// Returns a raw radix transaction
    /// instead of fetching the txs for each individual state_version
    /// we start a search at the beginning state version with the corresponding filters
    /// this improves the performance as there are probably very little to no relevant transactions in the given sv range
    pub async fn get_raw_txs(
        &self,
        from_state_version: u64,
        end_state_version: u64,
        emitter: Option<&str>,
    ) -> ChainResult<Vec<CommittedTransactionInfo>> {
        let selector = LedgerStateSelector {
            state_version: Some(Some(from_state_version)),
            ..Default::default()
        };

        let mut request = StreamTransactionsRequest::new();
        request.from_ledger_state = Some(Some(selector));
        request.event_global_emitters_filter = emitter.map(|emitter| vec![emitter.to_owned()]);
        request.order = Some(gateway_api_client::models::stream_transactions_request::Order::Asc);
        request.opt_ins = Some(TransactionDetailsOptIns {
            receipt_events: Some(true),
            ..Default::default()
        });

        let mut cursor = None;
        let mut txs = vec![];

        loop {
            let response = self
                .stream_txs(StreamTransactionsRequest {
                    cursor,
                    ..request.clone()
                })
                .await?;

            for item in response.items {
                // the cursor is open end and will go up to the most recent state version
                // dismiss all the txs that are not in the specified state version range
                if item.state_version as u64 > end_state_version {
                    return Ok(txs);
                }
                txs.push(item)
            }

            match response.next_cursor {
                Some(c) => cursor = Some(c),
                None => break,
            }
        }

        Ok(txs)
    }

    /// Returns a tx builder with header information already filled in
    pub fn get_tx_builder(
        network: &NetworkDefinition,
        private_key: &PrivateKey,
        epoch: u64,
        intent_discriminator: u64,
    ) -> TransactionV2Builder {
        TransactionBuilder::new_v2()
            .transaction_header(TransactionHeaderV2 {
                notary_public_key: private_key.public_key(),
                notary_is_signatory: true,
                tip_basis_points: 0u32, // TODO: what should we set this to?
            })
            .intent_header(IntentHeaderV2 {
                network_id: network.id,
                start_epoch_inclusive: Epoch::of(epoch),
                end_epoch_exclusive: Epoch::of(epoch + 2), // ~5 minutes per epoch -> 10min timeout
                intent_discriminator,
                min_proposer_timestamp_inclusive: None, // TODO: discuss whether or not we want to have a time limit
                max_proposer_timestamp_exclusive: None,
            })
    }

    /// build tx
    pub fn build_tx(
        signer: &RadixSigner,
        network: &NetworkDefinition,
        epoch: u64,
        intent_discriminator: u64,
        build_manifest: impl Fn(TransactionManifestV2Builder) -> TransactionManifestV2Builder,
        fee: FeeSummary,
    ) -> ChainResult<DetailedNotarizedTransactionV2> {
        let private_key = signer.get_signer()?;
        let tx_builder = Self::get_tx_builder(network, &private_key, epoch, intent_discriminator);

        let simulation = fee;
        let simulated_xrd = RadixProvider::total_fee(simulation)?
            * Decimal::from_str("1.5").map_err(HyperlaneRadixError::from)?;

        let tx = tx_builder
            .manifest_builder(|builder| {
                build_manifest(builder.lock_fee(signer.address, simulated_xrd))
            })
            .notarize(&private_key)
            .build();
        Ok(tx)
    }

    /// Returns the total Fee that was paid
    pub fn total_fee(fee_summary: FeeSummary) -> ChainResult<Decimal> {
        let execution = Decimal::try_from(fee_summary.xrd_total_execution_cost)
            .map_err(HyperlaneRadixError::from)?;
        let finaliztaion = Decimal::try_from(fee_summary.xrd_total_finalization_cost)
            .map_err(HyperlaneRadixError::from)?;
        let royalty = Decimal::try_from(fee_summary.xrd_total_royalty_cost)
            .map_err(HyperlaneRadixError::from)?;
        let storage_cost = Decimal::try_from(fee_summary.xrd_total_storage_cost)
            .map_err(HyperlaneRadixError::from)?;

        Ok(execution + finaliztaion + royalty + storage_cost)
    }

    /// Sends a tx to the gateway
    /// NOTE: does not wait for inclusion
    pub async fn send_tx(
        &self,
        build_manifest: impl Fn(TransactionManifestV2Builder) -> TransactionManifestV2Builder,
        fee: Option<FeeSummary>,
    ) -> ChainResult<TxOutcome> {
        let signer = self.get_signer()?;
        let private_key = signer.get_signer()?;
        // Use random discriminator to avoid collisions
        let intent_discriminator = rand::random::<u64>();
        let epoch = self.provider.gateway_status().await?.ledger_state.epoch as u64;

        let tx_builder = Self::get_tx_builder(
            &self.conf.network,
            &private_key,
            epoch,
            intent_discriminator,
        );

        let manifest = build_manifest(ManifestBuilder::new_v2()).build();
        let simulation = tx_builder
            .clone()
            .manifest(manifest)
            .build_preview_transaction(vec![])
            .to_raw()
            .map_err(HyperlaneRadixError::from)?;

        let simulation = match fee {
            Some(summary) => summary,
            None => self.simulate_raw_tx(simulation.to_vec()).await?.fee_summary,
        };

        let tx = Self::build_tx(
            signer,
            &self.conf.network,
            epoch,
            intent_discriminator,
            build_manifest,
            simulation,
        )?;

        self.submit_transaction(tx.raw.to_vec()).await?;

        let tx_hash: H512 =
            H256::from_slice(tx.transaction_hashes.transaction_intent_hash.0.as_bytes()).into();

        // Polling delay is the total amount of seconds to wait before we call a timeout
        const TIMEOUT_DELAY: u64 = 60;
        const POLLING_INTERVAL: u64 = 2;
        const N: usize = (TIMEOUT_DELAY / POLLING_INTERVAL) as usize;
        let hash = encode_tx(&self.conf.network, tx_hash.into())?;
        let mut attempt = 0;

        let status = loop {
            let tx_status = self.get_tx_status(tx_hash).await?;

            match tx_status.status {
                models::TransactionStatus::CommittedSuccess
                | models::TransactionStatus::CommittedFailure => {
                    break Ok(tx_status.status);
                }
                models::TransactionStatus::Rejected => {
                    break Err(HyperlaneRadixError::Other(format!(
                        "Transacstion rejected: {:?}",
                        tx_status.error_message
                    )));
                }
                _ => {
                    tracing::debug!(
                        current_attempt = attempt,
                        total_wait_seconds = attempt as u64 * POLLING_INTERVAL,
                        status = ?tx_status.status,
                        hash = hash,
                        "Transaction still pending, continuing to poll"
                    );
                    // Transaction is still pending, continue polling
                    attempt += 1;
                    if attempt >= N {
                        return Err(HyperlaneRadixError::Other(format!(
                            "Transaction timed out after {TIMEOUT_DELAY} seconds"
                        ))
                        .into());
                    }
                    tokio::time::sleep(Duration::from_secs(POLLING_INTERVAL)).await;
                    continue;
                }
            }
        }?;

        let details = self.get_txn_by_hash(&tx_hash).await?;
        let gas_price = details.gas_price.unwrap_or_default().try_into()?;

        Ok(TxOutcome {
            transaction_id: tx_hash,
            executed: status == models::TransactionStatus::CommittedSuccess,
            gas_used: details.gas_limit,
            gas_price,
        })
    }

    /// Sends a tx to the gateway
    /// NOTE: does not wait for inclusion
    pub async fn simulate_tx(
        &self,
        build_manifest: impl Fn(TransactionManifestV2Builder) -> TransactionManifestV2Builder,
    ) -> ChainResult<TransactionReceipt> {
        let signer = self.get_signer()?;
        let private_key = signer.get_signer()?;
        // Use random discriminator to avoid collisions
        let intent_discriminator = rand::random::<u64>();

        let epoch = self.provider.gateway_status().await?.ledger_state.epoch as u64;
        let tx = Self::get_tx_builder(
            &self.conf.network,
            &private_key,
            epoch,
            intent_discriminator,
        );

        let manifest = build_manifest(ManifestBuilder::new_v2()).build();
        let tx = tx
            .manifest(manifest)
            .build_preview_transaction(vec![])
            .to_raw()
            .map_err(HyperlaneRadixError::from)?;

        self.simulate_raw_tx(tx.to_vec()).await
    }

    /// Simulates a raw tx to the gateway to be included
    pub async fn simulate_raw_tx(&self, tx: Vec<u8>) -> ChainResult<TransactionReceipt> {
        let response = self
            .transaction_preview(TransactionPreviewV2Request {
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

        let Some(receipt) = response.receipt else {
            return Err(HyperlaneRadixError::ParsingError("receipt".to_owned()).into());
        };
        let receipt: TransactionReceipt =
            serde_json::from_value(receipt).map_err(HyperlaneRadixError::from)?;
        Ok(receipt)
    }

    /// Returns the status of a send tx
    pub async fn get_tx_status(&self, hash: H512) -> ChainResult<TransactionStatusResponse> {
        let hash: H256 = hash.into();
        let hash = encode_tx(&self.conf.network, hash)?;
        let response = self.transaction_status(hash).await?;
        Ok(response)
    }

    fn find_first_component_address(
        hash: &H512,
        network: &NetworkDefinition,
        addresses: &[String],
    ) -> Option<H256> {
        let address_bech32_decoder = AddressBech32Decoder::new(network);
        addresses
            .iter()
            .filter(|addr| addr.starts_with("component_"))
            .filter_map(
                |addr| match address_bech32_decoder.validate_and_decode(addr) {
                    Ok(s) => Some(s),
                    Err(err) => {
                        tracing::warn!(?err, ?hash, "Failed to decode component address");
                        None
                    }
                },
            )
            .map(|addr| radix_address_bytes_to_h256(&addr.1))
            .next()
    }
}

impl HyperlaneChain for RadixProvider {
    /// Return the domain
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    /// A provider for the chain
    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.clone())
    }
}

#[async_trait]
impl HyperlaneProvider for RadixProvider {
    /// Get block info for a given block height
    async fn get_block_by_height(&self, height: u64) -> ChainResult<BlockInfo> {
        // Radix doesn't have any blocks
        // we will fetch TXs at the given height instead and return the resulting information from them
        let tx = self
            .stream_txs(StreamTransactionsRequest {
                at_ledger_state: Some(Some(LedgerStateSelector {
                    state_version: Some(Some(height)),
                    ..Default::default()
                })),
                limit_per_page: Some(Some(1)),
                ..Default::default()
            })
            .await?;

        if tx.items.is_empty() {
            return Err(HyperlaneRadixError::Other(format!(
                "Expected at least one tx for state version: {height}"
            ))
            .into());
        }

        let datetime = DateTime::parse_from_rfc3339(&tx.ledger_state.proposer_round_timestamp)
            .map_err(HyperlaneRadixError::from)?;
        let timestamp = datetime.with_timezone(&Utc).timestamp() as u64;
        let height_bytes = U256::from(tx.ledger_state.state_version).to_vec();
        Ok(BlockInfo {
            hash: H256::from_slice(&height_bytes),
            timestamp,
            number: height,
        })
    }

    /// Get txn info for a given txn hash
    async fn get_txn_by_hash(&self, hash: &H512) -> ChainResult<TxnInfo> {
        let tx = self.get_tx_by_hash(hash).await?;
        let Some(receipt) = tx.receipt else {
            return Err(HyperlaneRadixError::ParsingError("receipt".to_owned()).into());
        };

        let Some(tx_manifest) = tx.manifest_instructions else {
            return Err(
                HyperlaneRadixError::ParsingError("manifest_instructions".to_owned()).into(),
            );
        };

        let affected_global_entities = tx.affected_global_entities.unwrap_or_default();

        // Radix doesn't have the concept of a single "primary" recipient of a transaction
        // so its hard to who/what the "primary" entity each transaction is for.
        // Instead, we just use the first component address in a transaction
        let first_component_address =
            Self::find_first_component_address(hash, &self.conf.network, &affected_global_entities);

        // We assume the account that locked up XRD to pay for fees is the sender of the transaction.
        // If we can't find fee payer, then default to H256::zero()
        let fee_payer =
            find_fee_payer_from_manifest(&tx_manifest, &self.conf.network).unwrap_or_default();

        let Some(fee_summary) = receipt.fee_summary else {
            return Err(
                HyperlaneRadixError::ParsingError("expected fee summary".to_owned()).into(),
            );
        };

        let fee_summary: FeeSummary =
            serde_json::from_value(fee_summary).map_err(HyperlaneRadixError::from)?;

        let Some(fee_paid) = tx.fee_paid else {
            return Err(
                HyperlaneRadixError::ParsingError("expected fee_paid in tx".to_owned()).into(),
            );
        };

        let fee_paid = Decimal::try_from(fee_paid).map_err(HyperlaneRadixError::from)?;
        let gas_limit = fee_summary.execution_cost_units_consumed
            + fee_summary.finalization_cost_units_consumed;
        let gas_price: Decimal = if gas_limit == 0 {
            Decimal::zero()
        } else {
            fee_paid / gas_limit
        };

        let gas_price = decimal_to_u256(gas_price);

        Ok(TxnInfo {
            hash: *hash,
            gas_limit: gas_limit.into(),
            max_priority_fee_per_gas: None,
            max_fee_per_gas: None,
            gas_price: Some(gas_price),
            // TODO: double check if we need a nonce, there are no nonces in radix, we might want to use the discriminator instead
            nonce: 0,
            sender: fee_payer,
            recipient: first_component_address,
            receipt: Some(TxnReceiptInfo {
                gas_used: U256::from(gas_limit),
                cumulative_gas_used: gas_price,
                effective_gas_price: Some(gas_price),
            }),
            raw_input_data: None,
        })
    }

    /// Returns whether a contract exists at the provided address
    async fn is_contract(&self, _address: &H256) -> ChainResult<bool> {
        Ok(true) // TODO: check if the given address is a global component
    }

    /// Fetch the balance of the wallet address associated with the chain provider.
    async fn get_balance(&self, address: String) -> ChainResult<U256> {
        let balance: Decimal = self.call_method_with_arg(&address, "balance", &XRD).await?;
        Ok(decimal_to_u256(balance))
    }

    /// Fetch metrics related to this chain
    async fn get_chain_metrics(&self) -> ChainResult<Option<hyperlane_core::ChainInfo>> {
        let state_version = self.get_state_version(None).await?;
        let block_info = self.get_block_by_height(state_version).await?;
        Ok(Some(hyperlane_core::ChainInfo::new(block_info, None)))
    }
}

/// Data required to send a tx on radix
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct RadixTxCalldata {
    /// Address of contract
    pub component_address: String,
    /// Method to call on contract
    pub method_name: String,
    /// parameters required to call method
    pub encoded_arguments: Vec<u8>,
}

#[cfg(test)]
mod tests {
    use radix_common::manifest_args;
    use scrypto::{
        prelude::{manifest_decode, ManifestArgs, ManifestValue},
        types::ComponentAddress,
    };

    use hyperlane_core::{Encode, HyperlaneMessage};

    use super::*;

    /// Test to ensure data produced from manifest_args!
    /// can be correctly serialized from hyperlane-radix and
    /// sent to lander.
    /// Then lander can successfully deserialize it
    #[test]
    pub fn test_decode_manifest_args() {
        let message = HyperlaneMessage::default();
        let visible_components: Vec<ComponentAddress> = vec![];
        let metadata: Vec<u8> = vec![1, 2, 3, 4];

        let args: ManifestArgs = manifest_args!(&metadata, &message.to_vec(), &visible_components);

        let encoded_args = manifest_encode(&args).expect("Failed to encode");

        let manifest_args: ManifestValue =
            manifest_decode(&encoded_args).expect("Failed to decode");

        let expected = ManifestValue::Tuple {
            fields: vec![
                ManifestValue::Array {
                    element_value_kind: sbor::ValueKind::U8,
                    elements: metadata
                        .iter()
                        .map(|v| sbor::Value::U8 { value: *v })
                        .collect(),
                },
                ManifestValue::Array {
                    element_value_kind: sbor::ValueKind::U8,
                    elements: message
                        .to_vec()
                        .iter()
                        .map(|v| sbor::Value::U8 { value: *v })
                        .collect(),
                },
                ManifestValue::Array {
                    element_value_kind: sbor::ValueKind::Custom(
                        scrypto::prelude::ManifestCustomValueKind::Address,
                    ),
                    elements: vec![],
                },
            ],
        };
        assert_eq!(manifest_args, expected);
    }
}
