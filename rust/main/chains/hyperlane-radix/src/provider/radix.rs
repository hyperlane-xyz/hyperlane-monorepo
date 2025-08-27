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
        ProgrammaticScryptoSborValue, StateEntityDetailsRequest, StreamTransactionsRequest,
        TransactionCommittedDetailsRequest, TransactionDetailsOptIns, TransactionPreviewV2Request,
        TransactionStatusResponse,
    },
};
use radix_common::traits::ScryptoEvent;
use radix_transactions::{
    builder::{
        ManifestBuilder, TransactionBuilder, TransactionManifestV2Builder, TransactionV2Builder,
    },
    model::{IntentHeaderV2, TransactionHeaderV2, TransactionPayload},
    signing::PrivateKey,
};
use reqwest::ClientBuilder;
use scrypto::{
    constants::XRD,
    crypto::IsHash,
    data::{
        manifest::{manifest_encode, ManifestEncode},
        scrypto::{scrypto_decode, ScryptoSbor},
    },
    math::Decimal,
    types::Epoch,
};

use hyperlane_core::{
    rpc_clients::FallbackProvider, BlockInfo, ChainCommunicationError, ChainInfo, ChainResult,
    ContractLocator, Encode, HyperlaneChain, HyperlaneDomain, HyperlaneProvider, LogMeta,
    ReorgPeriod, TxOutcome, TxnInfo, H256, H512, U256,
};

use crate::{
    decimal_to_u256, decode_bech32, encode_tx, provider::RadixGatewayProvider, signer::RadixSigner,
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
    fn build_fallback_provider(conf: &ConnectionConf) -> ChainResult<RadixFallbackProvider> {
        let mut gateway_provider = Vec::with_capacity(conf.gateway.len());
        for (index, url) in conf.gateway.iter().enumerate() {
            let map = conf.gateway_header.get(index).cloned().unwrap_or_default();
            let header = reqwest::header::HeaderMap::try_from(&map)
                .map_err(ChainCommunicationError::from_other)?;

            let client = ClientBuilder::new()
                .default_headers(header)
                .build()
                .map_err(ChainCommunicationError::from_other)?;

            let provider = RadixBaseGatewayProvider::new(GatewayConfig {
                client,
                base_path: url.to_string().trim_end_matches('/').to_string(),
                ..Default::default()
            });
            gateway_provider.push(provider);
        }

        let mut core_provider = Vec::with_capacity(conf.core.len());
        for (index, url) in conf.core.iter().enumerate() {
            let map = conf.core_header.get(index).cloned().unwrap_or_default();
            let header = reqwest::header::HeaderMap::try_from(&map)
                .map_err(ChainCommunicationError::from_other)?;

            let client = ClientBuilder::new()
                .default_headers(header)
                .build()
                .map_err(ChainCommunicationError::from_other)?;

            let provider = RadixBaseCoreProvider::new(
                CoreConfig {
                    client,
                    base_path: url.to_string().trim_end_matches('/').to_string(),
                    ..Default::default()
                },
                conf.network.clone(),
            );
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
    ) -> ChainResult<RadixProvider> {
        Ok(Self {
            domain: locator.domain.clone(),
            signer,
            reorg: reorg.clone(),
            provider: Self::build_fallback_provider(conf)?,
            conf: conf.clone(),
        })
    }

    fn get_signer(&self) -> ChainResult<&RadixSigner> {
        let signer = self
            .signer
            .as_ref()
            .ok_or(HyperlaneRadixError::SignerMissing)?;
        Ok(signer)
    }

    /// Calls a method on a component
    pub async fn call_method<T: ScryptoSbor>(
        &self,
        component: &str,
        method: &str,
        state_version: Option<u64>,
        raw_args: Vec<Vec<u8>>,
    ) -> ChainResult<T> {
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
                    return Ok(scrypto_decode::<T>(&data).map_err(HyperlaneRadixError::from)?);
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
    /// if specified will use the passed state_version
    pub async fn call_method_with_arg<T: ScryptoSbor, A: ManifestEncode + ?Sized>(
        &self,
        component: &str,
        method: &str,
        state_version: Option<u64>,
        argument: &A,
    ) -> ChainResult<T> {
        let arguments = manifest_encode(argument).map_err(HyperlaneRadixError::from)?;

        self.call_method(component, method, state_version, vec![arguments])
            .await
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

                        let height = U256::from(tx.state_version).to_vec();

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
                    receipt_events: Some(true),
                    receipt_fee_summary: Some(true),
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
    pub async fn get_tx_builder(
        &self,
    ) -> ChainResult<(TransactionV2Builder, &RadixSigner, PrivateKey)> {
        let signer = self.get_signer()?;
        let private_key = signer.get_signer()?;

        let epoch = self.provider.gateway_status().await?.ledger_state.epoch as u64;
        let tx = TransactionBuilder::new_v2()
            .transaction_header(TransactionHeaderV2 {
                notary_public_key: private_key.public_key(),
                notary_is_signatory: false,
                tip_basis_points: 0u32, // TODO: what should we set this to?
            })
            .intent_header(IntentHeaderV2 {
                network_id: self.conf.network.id,
                start_epoch_inclusive: Epoch::of(epoch),
                end_epoch_exclusive: Epoch::of(epoch + 2), // ~5 minutes per epoch -> 10min timeout
                intent_discriminator: 0u64, // TODO: do we want this to happen? This is used like a nonce
                min_proposer_timestamp_inclusive: None, // TODO: discuss whether or not we want to have a time limit
                max_proposer_timestamp_exclusive: None,
            });
        Ok((tx, signer, private_key))
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
        let (tx_builder, signer, private_key) = self.get_tx_builder().await?;

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
        let simulated_xrd = Self::total_fee(simulation)?
            * Decimal::from_str("1.5").map_err(HyperlaneRadixError::from)?;

        let tx = tx_builder
            .manifest_builder(|builder| {
                build_manifest(builder.lock_fee(signer.address, simulated_xrd))
            })
            .sign(&private_key)
            .notarize(&private_key)
            .build();

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
                            "Transaction timed out after {} seconds",
                            TIMEOUT_DELAY
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
        let (tx, _, _) = self.get_tx_builder().await?;
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
                "Expected at least one tx for state version: {}",
                height
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
            nonce: 0, // TODO: double check if we need a nonce, there are no nonces in radix, we might want to use the discriminator instead
            sender: H256::zero(), // TODO: this is not easy to figure out, we can use the notary public key, but it is not always the sender
            recipient: None, // TODO: hard to tell what the tx interacted with, this can be with more than just one person, maybe use the the first component address?
            receipt: None,
            raw_input_data: None,
        })
    }

    /// Returns whether a contract exists at the provided address
    async fn is_contract(&self, _address: &H256) -> ChainResult<bool> {
        Ok(true) // TODO: check if the given address is a global component
    }

    /// Fetch the balance of the wallet address associated with the chain provider.
    async fn get_balance(&self, address: String) -> ChainResult<U256> {
        let details = self
            .entity_details(StateEntityDetailsRequest {
                addresses: vec![address],
                opt_ins: Some(models::StateEntityDetailsOptIns {
                    native_resource_details: Some(true),
                    ..Default::default()
                }),
                ..Default::default()
            })
            .await?;

        for d in details.items {
            if let Some(resources) = d.fungible_resources {
                for i in resources.items {
                    let (address, amount) = match i {
                        models::FungibleResourcesCollectionItem::Global(x) => {
                            let amount =
                                Decimal::try_from(x.amount).map_err(HyperlaneRadixError::from)?;
                            (x.resource_address, amount)
                        }
                        models::FungibleResourcesCollectionItem::Vault(v) => {
                            // aggregate all the vaults amounts
                            let amount = v
                                .vaults
                                .items
                                .into_iter()
                                .map(|x| Decimal::try_from(x.amount))
                                .collect::<Result<Vec<_>, _>>()
                                .map_err(HyperlaneRadixError::from)?
                                .into_iter()
                                .reduce(|a, b| a + b)
                                .unwrap_or_default();
                            (v.resource_address, amount)
                        }
                    };
                    let address = decode_bech32(&address)?;
                    if address == XRD.to_vec() {
                        return Ok(decimal_to_u256(amount));
                    }
                }
            }
        }

        Ok(U256::zero())
    }

    /// Fetch metrics related to this chain
    async fn get_chain_metrics(&self) -> ChainResult<Option<ChainInfo>> {
        return Ok(None);
    }
}
