use std::ops::RangeInclusive;

use crate::binary::h256_to_h512;
use async_trait::async_trait;
use cosmrs::rpc::client::{Client, CompatMode, HttpClient};
use cosmrs::rpc::endpoint::tx;
use cosmrs::rpc::query::Query;
use cosmrs::rpc::Order;
use cosmrs::tendermint::abci::EventAttribute;
use hyperlane_core::{ChainCommunicationError, ChainResult, ContractLocator, LogMeta, H256, U256};
use tracing::debug;

use crate::verify::digest_to_addr;
use crate::ConnectionConf;

const PAGINATION_LIMIT: u8 = 100;

#[async_trait]
/// Trait for wasm indexer. Use rpc provider
pub trait WasmIndexer: Send + Sync {
    /// get latest finalized block height
    async fn get_finalized_block_number(&self) -> ChainResult<u32>;
    /// get range event logs
    async fn get_range_event_logs<T>(
        &self,
        range: RangeInclusive<u32>,
        parser: fn(Vec<EventAttribute>) -> ChainResult<Option<T>>,
    ) -> ChainResult<Vec<(T, LogMeta)>>
    where
        T: Send + Sync;
}

#[derive(Debug)]
/// Cosmwasm RPC Provider
pub struct CosmosWasmIndexer {
    client: HttpClient,
    contract_address: H256,
    contract_address_bech32: String,
    event_type: String,
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
            event_type,
            reorg_period,
        })
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

    async fn get_range_event_logs<T>(
        &self,
        range: RangeInclusive<u32>,
        parser: fn(Vec<EventAttribute>) -> ChainResult<Option<T>>,
    ) -> ChainResult<Vec<(T, LogMeta)>>
    where
        T: Send + Sync,
    {
        // Page starts from 1
        let query = Query::default()
            .and_gte("tx.height", *range.start() as u64)
            .and_lte("tx.height", *range.end() as u64)
            .and_eq(
                format!("{}-{}._contract_address", Self::WASM_TYPE, self.event_type),
                self.contract_address_bech32.clone(),
            );

        debug!("Query: {:?}", query.to_string());

        let tx_search_result = self
            .client
            .tx_search(query.clone(), false, 1, PAGINATION_LIMIT, Order::Ascending)
            .await?;

        let total_count = tx_search_result.total_count;
        let last_page = total_count / PAGINATION_LIMIT as u32
            + (total_count % PAGINATION_LIMIT as u32 != 0) as u32;

        let handler = |txs: Vec<tx::Response>| -> ChainResult<Vec<(T, LogMeta)>> {
            let mut result: Vec<(T, LogMeta)> = vec![];
            let target_type = format!("{}-{}", Self::WASM_TYPE, self.event_type);

            for tx in txs {
                if tx.tx_result.code.is_err() {
                    debug!(tx_hash=?tx.hash, "Indexed tx has failed, skipping");
                    continue;
                }

                let mut parse_result: Vec<(T, LogMeta)> = vec![];

                for (log_idx, event) in tx.tx_result.events.clone().into_iter().enumerate() {
                    if event.kind.as_str() == target_type {
                        if let Some(msg) = parser(event.attributes.clone())? {
                            let meta = LogMeta {
                                address: self.contract_address,
                                block_number: tx.height.value(),
                                // FIXME: block_hash is not available in tx_search
                                block_hash: H256::zero(),
                                transaction_id: h256_to_h512(H256::from_slice(tx.hash.as_bytes())),
                                transaction_index: tx.index as u64,
                                log_index: U256::from(log_idx),
                            };

                            parse_result.push((msg, meta));
                        }
                    }
                }

                result.extend(parse_result);
            }

            Ok(result)
        };

        let mut result = handler(tx_search_result.txs)?;

        for page in 2..=last_page {
            debug!(page, "Making tx search RPC");

            let tx_search_result = self
                .client
                .tx_search(
                    query.clone(),
                    false,
                    page,
                    PAGINATION_LIMIT,
                    Order::Ascending,
                )
                .await?;

            result.extend(handler(tx_search_result.txs)?);
        }

        Ok(result)
    }
}
