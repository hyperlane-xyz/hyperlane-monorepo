use std::ops::RangeInclusive;

use async_trait::async_trait;
use cosmrs::rpc::client::Client;
use cosmrs::rpc::endpoint::{tx, tx_search::Response as TxSearchResponse};
use cosmrs::rpc::query::Query;
use cosmrs::rpc::Order;
use cosmrs::tendermint::abci::EventAttribute;
use hyperlane_core::{ChainCommunicationError, ChainResult, ContractLocator, LogMeta, H256, U256};
use tracing::{instrument, trace};

use crate::address::CosmosAddress;
use crate::{ConnectionConf, CosmosProvider, HyperlaneCosmosError};

const PAGINATION_LIMIT: u8 = 100;

#[async_trait]
/// Trait for wasm indexer. Use rpc provider
pub trait WasmIndexer: Send + Sync {
    /// Get the finalized block height.
    async fn get_finalized_block_number(&self) -> ChainResult<u32>;

    /// Get logs for the given range using the given parser.
    async fn get_range_event_logs<T>(
        &self,
        range: RangeInclusive<u32>,
        parser: for<'a> fn(&'a Vec<EventAttribute>) -> ChainResult<ParsedEvent<T>>,
    ) -> ChainResult<Vec<(T, LogMeta)>>
    where
        T: Send + Sync + PartialEq + 'static;
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
}

#[derive(Debug)]
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
}

impl CosmosWasmIndexer {
    #[instrument(level = "trace", err, skip(self))]
    async fn tx_search(&self, query: Query, page: u32) -> ChainResult<TxSearchResponse> {
        Ok(self
            .provider
            .rpc()
            .tx_search(query, false, page, PAGINATION_LIMIT, Order::Ascending)
            .await
            .map_err(Into::<HyperlaneCosmosError>::into)?)
    }

    // Iterate through all txs, filter out failed txs, find target events
    // in successful txs, and parse them.
    fn handle_txs<T>(
        &self,
        txs: Vec<tx::Response>,
        parser: for<'a> fn(&'a Vec<EventAttribute>) -> ChainResult<ParsedEvent<T>>,
    ) -> ChainResult<impl Iterator<Item = (T, LogMeta)> + '_>
    where
        T: PartialEq + 'static,
    {
        let logs_iter = txs
            .into_iter()
            .filter(|tx| {
                // Filter out failed txs
                let tx_failed = tx.tx_result.code.is_err();
                if tx_failed {
                    trace!(tx_hash=?tx.hash, "Indexed tx has failed, skipping");
                }
                !tx_failed
            })
            .flat_map(move |tx| {
                // Find target events in successful txs
                self.handle_tx(tx, parser)
            });

        Ok(logs_iter)
    }

    // Iter through all events in the tx, looking for any target events
    // made by the contract we are indexing.
    fn handle_tx<T>(
        &self,
        tx: tx::Response,
        parser: for<'a> fn(&'a Vec<EventAttribute>) -> ChainResult<ParsedEvent<T>>,
    ) -> impl Iterator<Item = (T, LogMeta)> + '_
    where
        T: PartialEq + 'static,
    {
        tx.tx_result.events.into_iter().enumerate().filter_map(move |(log_idx, event)| {
            if event.kind.as_str() != self.target_event_kind {
                return None;
            }

            parser(&event.attributes)
                .map_err(|err| {
                    // This can happen if we attempt to parse an event that just happens
                    // to have the same name but a different structure.
                    tracing::trace!(?err, tx_hash=?tx.hash, log_idx, ?event, "Failed to parse event attributes");
                })
                .ok()
                .and_then(|parsed_event| {
                    // This is crucial! We need to make sure that the contract address
                    // in the event matches the contract address we are indexing.
                    // Otherwise, we might index events from other contracts that happen
                    // to have the same target event name.
                    if parsed_event.contract_address != self.contract_address.address() {
                        trace!(tx_hash=?tx.hash, log_idx, ?event, "Event contract address does not match indexer contract address");
                        return None;
                    }

                    Some((parsed_event.event, LogMeta {
                        address: self.contract_address.digest(),
                        block_number: tx.height.value(),
                        // FIXME: block_hash is not available in tx_search.
                        // This isn't strictly required atm.
                        block_hash: H256::zero(),
                        transaction_id: H256::from_slice(tx.hash.as_bytes()).into(),
                        transaction_index: tx.index.into(),
                        log_index: U256::from(log_idx),
                    }))
                })
            })
    }
}

#[async_trait]
impl WasmIndexer for CosmosWasmIndexer {
    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        let latest_height: u32 = self
            .provider
            .rpc()
            .latest_block()
            .await
            .map_err(Into::<HyperlaneCosmosError>::into)?
            .block
            .header
            .height
            .value()
            .try_into()
            .map_err(ChainCommunicationError::from_other)?;
        Ok(latest_height.saturating_sub(self.reorg_period))
    }

    #[instrument(err, skip(self, parser))]
    async fn get_range_event_logs<T>(
        &self,
        range: RangeInclusive<u32>,
        parser: for<'a> fn(&'a Vec<EventAttribute>) -> ChainResult<ParsedEvent<T>>,
    ) -> ChainResult<Vec<(T, LogMeta)>>
    where
        T: PartialEq + Send + Sync + 'static,
    {
        // Page starts from 1
        let query = Query::default()
            .and_gte("tx.height", *range.start() as u64)
            .and_lte("tx.height", *range.end() as u64)
            .and_eq(
                format!("{}._contract_address", self.target_event_kind),
                self.contract_address.address(),
            );

        let tx_search_result = self.tx_search(query.clone(), 1).await?;

        // Using the first tx_search_result, we can calculate the total number of pages.
        let total_count = tx_search_result.total_count;
        let last_page = div_ceil(total_count, PAGINATION_LIMIT.into());

        let mut logs = self
            .handle_txs(tx_search_result.txs, parser)?
            .collect::<Vec<_>>();

        // If there are any more pages, fetch them and append to the result.
        for page in 2..=last_page {
            trace!(page, "Performing tx search");

            let tx_search_result = self.tx_search(query.clone(), page).await?;

            logs.extend(self.handle_txs(tx_search_result.txs, parser)?);
        }

        Ok(logs)
    }
}

// TODO: just use div_ceil when upgrading from 1.72.1 to 1.73.0 or above
fn div_ceil(numerator: u32, denominator: u32) -> u32 {
    (numerator as f32 / denominator as f32).ceil() as u32
}
