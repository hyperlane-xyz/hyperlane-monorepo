use std::ops::RangeInclusive;

use crate::binary::h256_to_h512;
use async_trait::async_trait;
use cosmrs::rpc::client::{Client, CompatMode, HttpClient};
use cosmrs::rpc::endpoint::{tx, tx_search::Response as TxSearchResponse};
use cosmrs::rpc::query::Query;
use cosmrs::rpc::Order;
use cosmrs::tendermint::abci::EventAttribute;
use hyperlane_core::{ChainCommunicationError, ChainResult, ContractLocator, LogMeta, H256, U256};
use tracing::{debug, instrument, trace};

use crate::verify::digest_to_addr;
use crate::ConnectionConf;

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
        parser: for<'a> fn(&'a Vec<EventAttribute>) -> ChainResult<Option<T>>,
    ) -> ChainResult<Vec<(T, LogMeta)>>
    where
        T: Send + Sync + 'static;
}

#[derive(Debug)]
/// Cosmwasm RPC Provider
pub struct CosmosWasmIndexer {
    client: HttpClient,
    contract_address: H256,
    contract_address_bech32: String,
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
        let client = HttpClient::builder(conf.get_rpc_url().parse()?)
            // Consider supporting different compatibility modes.
            .compat_mode(CompatMode::latest())
            .build()?;
        Ok(Self {
            client,
            contract_address: locator.address,
            contract_address_bech32: digest_to_addr(locator.address, conf.get_prefix().as_str())?,
            target_event_kind: format!("{}-{}", Self::WASM_TYPE, event_type),
            reorg_period,
        })
    }
}

impl CosmosWasmIndexer {
    #[instrument(level = "trace", err, skip(self))]
    async fn tx_search(&self, query: Query, page: u32) -> ChainResult<TxSearchResponse> {
        Ok(self
            .client
            .tx_search(query, false, page, PAGINATION_LIMIT, Order::Ascending)
            .await?)
    }

    // Iterate through all txs, filter out failed txs, find target events
    // in successful txs, and parse them.
    fn handle_txs<T>(
        &self,
        txs: Vec<tx::Response>,
        parser: for<'a> fn(&'a Vec<EventAttribute>) -> ChainResult<Option<T>>,
    ) -> ChainResult<impl Iterator<Item = (T, LogMeta)> + '_>
    where
        T: 'static,
    {
        let logs_iter = txs
            .into_iter()
            .filter(|tx| {
                // Filter out failed txs
                if tx.tx_result.code.is_err() {
                    debug!(tx_hash=?tx.hash, "Indexed tx has failed, skipping");
                    false
                } else {
                    true
                }
            })
            .map(move |tx| {
                // Iter through all events in the tx, looking for the target
                let logs_for_tx = tx.tx_result.events.into_iter().enumerate().filter_map(move |(log_idx, event)| {
                    if event.kind.as_str() != self.target_event_kind {
                        return None;
                    }

                    parser(&event.attributes)
                        .map_err(|err| {
                            tracing::warn!(?err, tx_hash=?tx.hash, log_idx, ?event, "Failed to parse event attributes");
                        })
                        .ok()
                        .flatten()
                        .map(|msg| {
                            (msg, LogMeta {
                                address: self.contract_address,
                                block_number: tx.height.value(),
                                // FIXME: block_hash is not available in tx_search
                                block_hash: H256::zero(),
                                transaction_id: h256_to_h512(H256::from_slice(tx.hash.as_bytes())),
                                transaction_index: tx.index as u64,
                                log_index: U256::from(log_idx),
                            })
                        })
                    });
                logs_for_tx
            })
            .flatten();

        Ok(logs_iter)
    }
}

#[async_trait]
impl WasmIndexer for CosmosWasmIndexer {
    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        let latest_height: u32 = self
            .client
            .latest_block()
            .await?
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
        parser: for<'a> fn(&'a Vec<EventAttribute>) -> ChainResult<Option<T>>,
    ) -> ChainResult<Vec<(T, LogMeta)>>
    where
        T: Send + Sync + 'static,
    {
        // Page starts from 1
        let query = Query::default()
            .and_gte("tx.height", *range.start() as u64)
            .and_lte("tx.height", *range.end() as u64)
            .and_eq(
                format!("{}._contract_address", self.target_event_kind),
                self.contract_address_bech32.clone(),
            );

        // let handler = |txs: Vec<tx::Response>| -> ChainResult<Vec<(T, LogMeta)>> {
        //     // Iterate through all txs, filter out failed txs, find target events
        //     // in successful txs, and parse them.
        //     let logs: Vec<(T, LogMeta)> = txs
        //         .into_iter()
        //         .filter(|tx| {
        //             // Filter out failed txs
        //             if tx.tx_result.code.is_err() {
        //                 debug!(tx_hash=?tx.hash, "Indexed tx has failed, skipping");
        //                 false
        //             } else {
        //                 true
        //             }
        //         })
        //         .map(|tx| {
        //             // Iter through all events in the tx, looking for the target
        //             let logs_for_tx = tx.tx_result.events.into_iter().enumerate().filter_map(move |(log_idx, event)| {
        //                 if event.kind.as_str() != self.target_event_kind {
        //                     return None;
        //                 }

        //                 parser(&event.attributes)
        //                     .map_err(|err| {
        //                         tracing::warn!(?err, tx_hash=?tx.hash, log_idx, ?event, "Failed to parse event attributes");
        //                     })
        //                     .ok()
        //                     .flatten()
        //                     .map(|msg| {
        //                         (msg, LogMeta {
        //                             address: self.contract_address,
        //                             block_number: tx.height.value(),
        //                             // FIXME: block_hash is not available in tx_search
        //                             block_hash: H256::zero(),
        //                             transaction_id: h256_to_h512(H256::from_slice(tx.hash.as_bytes())),
        //                             transaction_index: tx.index as u64,
        //                             log_index: U256::from(log_idx),
        //                         })
        //                     })
        //                 });
        //             logs_for_tx
        //         })
        //         .flatten();
        //     // .collect();
        //     Ok(logs)
        // };

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

fn div_ceil(numerator: u32, denominator: u32) -> u32 {
    (numerator + denominator - 1) / denominator
}
