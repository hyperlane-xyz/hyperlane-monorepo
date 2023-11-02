use std::ops::RangeInclusive;

use crate::binary::h256_to_h512;
use async_trait::async_trait;
use cosmrs::rpc::client::{Client, HttpClient};
use cosmrs::rpc::endpoint::tx;
use cosmrs::rpc::query::Query;
use cosmrs::rpc::Order;
use cosmrs::tendermint::abci::EventAttribute;
use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, HyperlaneDomain, LogMeta, H256, U256,
};
use tracing::debug;

use crate::verify::{self, bech32_decode};
use crate::ConnectionConf;

const PAGINATION_LIMIT: u8 = 100;

#[async_trait]
/// Trait for wasm indexer. Use rpc provider
pub trait WasmIndexer: Send + Sync {
    /// get rpc client
    fn get_client(&self) -> ChainResult<HttpClient>;
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

// #[derive(Debug)]
// /// Cosmwasm RPC Provider
// pub struct CosmosWasmIndexer {
//     address: String,
//     rpc_endpoint: HttpClientUrl, // rpc_endpoint
//     target_type: String,
// }

#[derive(Debug)]
/// Cosmwasm RPC Provider
pub struct CosmosWasmIndexer {
    conf: ConnectionConf,
    _domain: HyperlaneDomain,
    address: H256,
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
    ) -> Self {
        Self {
            conf,
            _domain: locator.domain.clone(),
            address: locator.address,
            event_type,
            reorg_period,
        }
    }

    /// get rpc client url
    fn get_conn_url(&self) -> ChainResult<String> {
        Ok(self.conf.get_rpc_url())
    }

    /// get contract address
    pub fn get_contract_addr(&self) -> ChainResult<String> {
        verify::digest_to_addr(self.address, self.conf.get_prefix().as_str())
    }
}

#[async_trait]
impl WasmIndexer for CosmosWasmIndexer {
    fn get_client(&self) -> ChainResult<HttpClient> {
        Ok(HttpClient::builder(self.get_conn_url()?.parse()?)
            // indexing fails unless this is commented out. I assume the decoding in `CompatMode::V0_34`
            // is incompatible with the current data format.
            // .compat_mode(CompatMode::V0_34)
            .build()?)
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        let client = self.get_client()?;

        let latest_height: u32 = client
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
        let client = self.get_client()?;
        let contract_address = self.get_contract_addr()?;

        // Page starts from 1
        let query = Query::default()
            .and_gte("tx.height", *range.start() as u64)
            .and_lte("tx.height", *range.end() as u64)
            .and_eq(
                format!("{}-{}._contract_address", Self::WASM_TYPE, self.event_type),
                contract_address.clone(),
            );

        debug!("Query: {:?}", query.to_string());

        let tx_search_result = client
            .tx_search(query.clone(), false, 1, PAGINATION_LIMIT, Order::Ascending)
            .await?;

        let total_count = tx_search_result.total_count;
        let last_page = total_count / PAGINATION_LIMIT as u32
            + (total_count % PAGINATION_LIMIT as u32 != 0) as u32;

        let handler = |txs: Vec<tx::Response>| -> ChainResult<Vec<(T, LogMeta)>> {
            let mut result: Vec<(T, LogMeta)> = vec![];
            let target_type = format!("{}-{}", Self::WASM_TYPE, self.event_type);

            // Get BlockHash from block_search
            let client = self.get_client()?;

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
                                address: bech32_decode(contract_address.clone())?,
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

            let tx_search_result = client
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
