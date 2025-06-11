use std::fmt::Debug;

use async_trait::async_trait;
use cosmrs::cosmwasm::MsgExecuteContract;
use cosmrs::rpc::client::Client;
use futures::StreamExt;
use hyperlane_core::rpc_clients::{BlockNumberGetter, FallbackProvider};
use hyperlane_metric::prometheus_metric::{
    ChainInfo, ClientConnectionType, PrometheusClientMetrics, PrometheusConfig,
};
use sha256::digest;
use tendermint::abci::{Event, EventAttribute};
use tendermint::hash::Algorithm;
use tendermint::Hash;
use tendermint_rpc::client::CompatMode;
use tendermint_rpc::endpoint::block::Response as BlockResponse;
use tendermint_rpc::endpoint::block_results::{self, Response as BlockResultsResponse};
use tendermint_rpc::endpoint::tx;
use tendermint_rpc::HttpClient;
use time::OffsetDateTime;
use tracing::{debug, info, instrument, trace};

use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, HyperlaneDomain, LogMeta, H256, U256,
};

use crate::rpc::CosmosRpcClient;
use crate::rpc_clients::CosmosFallbackProvider;
use crate::{ConnectionConf, CosmosAddress, CosmosProvider, HyperlaneCosmosError};

#[async_trait]
/// Trait for wasm indexer. Use rpc provider
pub trait WasmRpcProvider: Send + Sync {
    /// Get the finalized block height.
    async fn get_finalized_block_number(&self) -> ChainResult<u32>;

    /// Get logs for the given block using the given parser.
    async fn get_logs_in_block<T>(
        &self,
        block_number: u32,
        parser: for<'a> fn(&'a Vec<EventAttribute>) -> ChainResult<ParsedEvent<T>>,
        cursor_label: &'static str,
    ) -> ChainResult<Vec<(T, LogMeta)>>
    where
        T: Send + Sync + PartialEq + Debug + 'static;

    /// Get logs for the given transaction using the given parser.
    async fn get_logs_in_tx<T>(
        &self,
        tx_hash: Hash,
        parser: for<'a> fn(&'a Vec<EventAttribute>) -> ChainResult<ParsedEvent<T>>,
        cursor_label: &'static str,
    ) -> ChainResult<Vec<(T, LogMeta)>>
    where
        T: Send + Sync + PartialEq + Debug + 'static;
}

#[derive(Debug, Eq, PartialEq)]
/// An event parsed from the RPC response.
pub struct ParsedEvent<T: PartialEq> {
    contract_address: String,
    event: T,
}

impl<T: PartialEq> ParsedEvent<T> {
    /// Create a new ParsedEvent.
    pub fn new(contract_address: String, event: T) -> Self {
        Self {
            contract_address,
            event,
        }
    }

    /// Get the inner event
    pub fn inner(self) -> T {
        self.event
    }
}

#[derive(Debug, Clone)]
/// Cosmwasm RPC Provider
pub struct CosmosWasmRpcProvider {
    domain: HyperlaneDomain,
    contract_address: CosmosAddress,
    target_event_kind: String,
    reorg_period: u32,
    rpc_client: CosmosFallbackProvider<CosmosRpcClient>,
}

impl CosmosWasmRpcProvider {
    const WASM_TYPE: &'static str = "wasm";

    /// create new Cosmwasm RPC Provider
    pub fn new(
        conf: &ConnectionConf,
        locator: &ContractLocator,
        event_type: String,
        reorg_period: u32,
        metrics: PrometheusClientMetrics,
        chain: Option<ChainInfo>,
    ) -> ChainResult<Self> {
        let providers = conf
            .get_rpc_urls()
            .iter()
            .map(|url| {
                let metrics_config =
                    PrometheusConfig::from_url(url, ClientConnectionType::Rpc, chain.clone());
                CosmosRpcClient::from_url(url, metrics.clone(), metrics_config)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut builder = FallbackProvider::builder();
        builder = builder.add_providers(providers);
        let fallback_provider = builder.build();
        let provider = CosmosFallbackProvider::new(fallback_provider);

        Ok(Self {
            domain: locator.domain.clone(),
            contract_address: CosmosAddress::from_h256(
                locator.address,
                conf.get_bech32_prefix().as_str(),
                conf.get_contract_address_bytes(),
            )?,
            target_event_kind: format!("{}-{}", Self::WASM_TYPE, event_type),
            reorg_period,
            rpc_client: provider,
        })
    }

    async fn get_block(&self, height: u32) -> ChainResult<BlockResponse> {
        self.rpc_client
            .call(|provider| Box::pin(async move { provider.get_block(height).await }))
            .await
    }
}

impl CosmosWasmRpcProvider {
    // Iterate through all txs, filter out failed txs, find target events
    // in successful txs, and parse them.
    fn handle_txs<T>(
        &self,
        block: BlockResponse,
        block_results: BlockResultsResponse,
        parser: for<'a> fn(&'a Vec<EventAttribute>) -> ChainResult<ParsedEvent<T>>,
        cursor_label: &'static str,
    ) -> Vec<(T, LogMeta)>
    where
        T: PartialEq + Debug + 'static,
    {
        let Some(tx_results) = block_results.txs_results else {
            return vec![];
        };

        let tx_hashes: Vec<Hash> = block
            .clone()
            .block
            .data
            .into_iter()
            .filter_map(|tx| hex::decode(digest(tx.as_slice())).ok())
            .filter_map(|hash| Hash::from_bytes(Algorithm::Sha256, hash.as_slice()).ok())
            .collect();

        tx_results
            .into_iter()
            .enumerate()
            .filter_map(move |(idx, tx)| {
                let Some(tx_hash) = tx_hashes.get(idx) else {
                    debug!(?tx, "No tx hash found for tx");
                    return None;
                };
                if tx.code.is_err() {
                    debug!(?tx_hash, "Not indexing failed transaction");
                    return None;
                }

                // We construct a simplified structure `tx::Response` here so that we can
                // reuse `handle_tx` method below.
                let tx_response = tx::Response {
                    hash: *tx_hash,
                    height: block_results.height,
                    index: idx as u32,
                    tx_result: tx,
                    tx: vec![],
                    proof: None,
                };

                let block_hash = H256::from_slice(block.block_id.hash.as_bytes());

                Some(self.handle_tx(tx_response, block_hash, parser))
            })
            .flatten()
            .collect()
    }

    // Iter through all events in the tx, looking for any target events
    // made by the contract we are indexing.
    fn handle_tx<T>(
        &self,
        tx: tx::Response,
        block_hash: H256,
        parser: for<'a> fn(&'a Vec<EventAttribute>) -> ChainResult<ParsedEvent<T>>,
    ) -> impl Iterator<Item = (T, LogMeta)> + '_
    where
        T: PartialEq + 'static,
    {
        let tx_events = tx.tx_result.events;
        let tx_hash = tx.hash;
        let tx_index = tx.index;
        let block_height = tx.height;

        tx_events.into_iter().enumerate().filter_map(move |(log_idx, event)| {
            if event.kind.as_str() != self.target_event_kind {
                return None;
            }

            parser(&event.attributes)
                .map_err(|err| {
                    // This can happen if we attempt to parse an event that just happens
                    // to have the same name but a different structure.
                    trace!(?err, tx_hash=?tx_hash, log_idx, ?event, "Failed to parse event attributes");
                })
                .ok()
                .and_then(|parsed_event| {
                    // This is crucial! We need to make sure that the contract address
                    // in the event matches the contract address we are indexing.
                    // Otherwise, we might index events from other contracts that happen
                    // to have the same target event name.
                    if parsed_event.contract_address != self.contract_address.address() {
                        trace!(tx_hash=?tx_hash, log_idx, ?event, "Event contract address does not match indexer contract address");
                        return None;
                    }

                    Some((parsed_event.event, LogMeta {
                        address: self.contract_address.digest(),
                        block_number: block_height.value(),
                        block_hash,
                        transaction_id: H256::from_slice(tx_hash.as_bytes()).into(),
                        transaction_index: tx_index as u64,
                        log_index: U256::from(log_idx),
                    }))
                })
        })
    }
}

#[async_trait]
impl WasmRpcProvider for CosmosWasmRpcProvider {
    #[instrument(err, skip(self))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        let latest_block = self
            .rpc_client
            .call(|provider| Box::pin(async move { provider.get_latest_block().await }))
            .await?;
        let latest_height: u32 = latest_block
            .block
            .header
            .height
            .value()
            .try_into()
            .map_err(ChainCommunicationError::from_other)?;
        Ok(latest_height.saturating_sub(self.reorg_period))
    }

    #[instrument(err, fields(domain = self.domain.name()), skip(self, parser))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn get_logs_in_block<T>(
        &self,
        block_number: u32,
        parser: for<'a> fn(&'a Vec<EventAttribute>) -> ChainResult<ParsedEvent<T>>,
        cursor_label: &'static str,
    ) -> ChainResult<Vec<(T, LogMeta)>>
    where
        T: Send + Sync + PartialEq + Debug + 'static,
    {
        // The two calls below could be made in parallel, but on cosmos rate limiting is a bigger problem
        // than indexing latency, so we do them sequentially.
        let block = self.get_block(block_number).await?;
        debug!(?block_number, block_hash = ?block.block_id.hash, cursor_label, domain=?self.domain.name(), "Getting logs in block with hash");
        let block_results = self
            .rpc_client
            .call(|provider| {
                Box::pin(async move { provider.get_block_results(block_number).await })
            })
            .await?;

        Ok(self.handle_txs(block, block_results, parser, cursor_label))
    }

    #[instrument(err, skip(self, parser))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn get_logs_in_tx<T>(
        &self,
        hash: Hash,
        parser: for<'a> fn(&'a Vec<EventAttribute>) -> ChainResult<ParsedEvent<T>>,
        cursor_label: &'static str,
    ) -> ChainResult<Vec<(T, LogMeta)>>
    where
        T: Send + Sync + PartialEq + Debug + 'static,
    {
        let tx = self
            .rpc_client
            .call(|provider| Box::pin(async move { provider.get_tx_by_hash(hash).await }))
            .await?;
        let block_number = tx.height.value() as u32;
        let block = self.get_block(block_number).await?;
        let block_hash = H256::from_slice(block.block_id.hash.as_bytes());

        debug!(?block_number, block_hash = ?block.block_id.hash, cursor_label, domain=?self.domain.name(), "Getting logs in transaction: block info");

        Ok(self.handle_tx(tx, block_hash, parser).collect())
    }
}

#[cfg(test)]
mod tests;
