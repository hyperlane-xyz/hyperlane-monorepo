use async_trait::async_trait;
use cosmrs::rpc::client::Client;
use hyperlane_core::{ChainCommunicationError, ChainResult, ContractLocator, LogMeta, H256, U256};
use sha256::digest;
use std::fmt::Debug;
use tendermint::abci::{Event, EventAttribute};
use tendermint::hash::Algorithm;
use tendermint::Hash;
use tendermint_rpc::endpoint::block::Response as BlockResponse;
use tendermint_rpc::endpoint::block_results::Response as BlockResultsResponse;
use tendermint_rpc::HttpClient;
use tracing::{debug, instrument, trace};

use crate::address::CosmosAddress;
use crate::{ConnectionConf, CosmosProvider, HyperlaneCosmosError};

#[async_trait]
/// Trait for wasm indexer. Use rpc provider
pub trait WasmIndexer: Send + Sync {
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
pub struct CosmosWasmIndexer {
    provider: CosmosProvider,
    contract_address: CosmosAddress,
    target_event_kind: String,
    reorg_period: u32,
}

impl CosmosWasmIndexer {
    const WASM_TYPE: &str = "wasm";

    /// create new Cosmwasm RPC Provider
    pub fn new(
        conf: ConnectionConf,
        locator: ContractLocator,
        event_type: String,
        reorg_period: u32,
    ) -> ChainResult<Self> {
        let provider = CosmosProvider::new(
            locator.domain.clone(),
            conf.clone(),
            Some(locator.clone()),
            None,
        )?;
        Ok(Self {
            provider,
            contract_address: CosmosAddress::from_h256(
                locator.address,
                conf.get_bech32_prefix().as_str(),
                conf.get_contract_address_bytes(),
            )?,
            target_event_kind: format!("{}-{}", Self::WASM_TYPE, event_type),
            reorg_period,
        })
    }

    async fn get_block(client: HttpClient, block_number: u32) -> ChainResult<BlockResponse> {
        Ok(client
            .block(block_number)
            .await
            .map_err(Into::<HyperlaneCosmosError>::into)?)
    }

    async fn get_block_results(
        client: HttpClient,
        block_number: u32,
    ) -> ChainResult<BlockResultsResponse> {
        Ok(client
            .block_results(block_number)
            .await
            .map_err(Into::<HyperlaneCosmosError>::into)?)
    }

    async fn get_latest_block(client: HttpClient) -> ChainResult<BlockResponse> {
        Ok(client
            .latest_block()
            .await
            .map_err(Into::<HyperlaneCosmosError>::into)?)
    }
}

impl CosmosWasmIndexer {
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

        let tx_hashes: Vec<H256> = block
            .clone()
            .block
            .data
            .into_iter()
            .filter_map(|tx| hex::decode(digest(tx.as_slice())).ok())
            .filter_map(|hash| {
                Hash::from_bytes(Algorithm::Sha256, hash.as_slice())
                    .ok()
                    .map(|hash| H256::from_slice(hash.as_bytes()))
            })
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
                Some(self.handle_tx(block.clone(), tx.events, *tx_hash, idx, parser))
            })
            .flatten()
            .collect()
    }

    // Iter through all events in the tx, looking for any target events
    // made by the contract we are indexing.
    fn handle_tx<T>(
        &self,
        block: BlockResponse,
        tx_events: Vec<Event>,
        tx_hash: H256,
        transaction_index: usize,
        parser: for<'a> fn(&'a Vec<EventAttribute>) -> ChainResult<ParsedEvent<T>>,
    ) -> impl Iterator<Item = (T, LogMeta)> + '_
    where
        T: PartialEq + 'static,
    {
        tx_events.into_iter().enumerate().filter_map(move |(log_idx, event)| {
            if event.kind.as_str() != self.target_event_kind {
                return None;
            }

            parser(&event.attributes)
                .map_err(|err| {
                    // This can happen if we attempt to parse an event that just happens
                    // to have the same name but a different structure.
                    tracing::trace!(?err, tx_hash=?tx_hash, log_idx, ?event, "Failed to parse event attributes");
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
                        block_number: block.block.header.height.into(),
                        block_hash: H256::from_slice(block.block_id.hash.as_bytes()),
                        transaction_id: H256::from_slice(tx_hash.as_bytes()).into(),
                        transaction_index: transaction_index as u64,
                        log_index: U256::from(log_idx),
                    }))
                })
            })
    }
}

#[async_trait]
impl WasmIndexer for CosmosWasmIndexer {
    #[instrument(err, skip(self))]
    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        let latest_block = Self::get_latest_block(self.provider.rpc().clone()).await?;
        let latest_height: u32 = latest_block
            .block
            .header
            .height
            .value()
            .try_into()
            .map_err(ChainCommunicationError::from_other)?;
        Ok(latest_height.saturating_sub(self.reorg_period))
    }

    #[instrument(err, skip(self, parser))]
    async fn get_logs_in_block<T>(
        &self,
        block_number: u32,
        parser: for<'a> fn(&'a Vec<EventAttribute>) -> ChainResult<ParsedEvent<T>>,
        cursor_label: &'static str,
    ) -> ChainResult<Vec<(T, LogMeta)>>
    where
        T: Send + Sync + PartialEq + Debug + 'static,
    {
        let client = self.provider.rpc().clone();
        debug!(?block_number, cursor_label, domain=?self.provider.domain, "Getting logs in block");

        // The two calls below could be made in parallel, but on cosmos rate limiting is a bigger problem
        // than indexing latency, so we do them sequentially.
        let block = Self::get_block(client.clone(), block_number).await?;
        let block_results = Self::get_block_results(client.clone(), block_number).await?;

        Ok(self.handle_txs(block, block_results, parser, cursor_label))
    }
}
