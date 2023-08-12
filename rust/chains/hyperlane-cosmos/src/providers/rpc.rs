use async_trait::async_trait;
use cosmrs::rpc::client::{Client, CompatMode, HttpClient};
use cosmrs::tendermint::abci::EventAttribute;
use cosmrs::tendermint::hash::Algorithm;
use cosmrs::tendermint::Hash;
use hyperlane_core::{ChainResult, ContractLocator, HyperlaneDomain, LogMeta, H256, H512, U256};
use sha256::digest;

use crate::verify::{self, bech32_decode};
use crate::ConnectionConf;

#[async_trait]
/// Trait for wasm indexer. Use rpc provider
pub trait WasmIndexer: Send + Sync {
    /// get rpc client
    fn get_client(&self) -> ChainResult<HttpClient>;
    /// get latest block height
    async fn latest_block_height(&self) -> ChainResult<u32>;
    /// get event log
    async fn get_event_log<T>(
        &self,
        block_number: u32,
        parser: fn(Vec<EventAttribute>) -> T,
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
    domain: HyperlaneDomain,
    address: H256,
    event_type: String,
}

impl CosmosWasmIndexer {
    const WASM_TYPE: &str = "wasm";

    /// create new Cosmwasm RPC Provider
    pub fn new(conf: ConnectionConf, locator: ContractLocator, event_type: String) -> Self {
        Self {
            conf,
            domain: locator.domain.clone(),
            address: locator.address,
            event_type,
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
            .compat_mode(CompatMode::V0_34)
            .build()?)
    }

    async fn latest_block_height(&self) -> ChainResult<u32> {
        let client = self.get_client()?;

        let result = client.latest_block().await?;
        Ok(result.block.header.height.value() as u32)
    }

    async fn get_event_log<T>(
        &self,
        block_number: u32,
        parser: fn(Vec<EventAttribute>) -> T,
    ) -> ChainResult<Vec<(T, LogMeta)>>
    where
        T: Send + Sync,
    {
        let client = self.get_client()?;

        let block = client.block(block_number).await?;
        let block_result = client.block_results(block_number).await?;

        let tx_hash: Vec<H256> = block
            .block
            .data
            .into_iter()
            .map(|tx| {
                H256::from_slice(
                    Hash::from_bytes(
                        Algorithm::Sha256,
                        hex::decode(digest(tx.as_slice())).unwrap().as_slice(),
                    )
                    .unwrap()
                    .as_bytes(),
                )
            })
            .collect();

        let mut result: Vec<(T, LogMeta)> = vec![];
        let tx_results = block_result.txs_results.unwrap();
        let addr = self.get_contract_addr()?;

        for (idx, tx) in tx_results.iter().enumerate() {
            let tx_hash = tx_hash[idx];
            let mut available = false;

            let mut parse_result: Vec<(T, LogMeta)> = vec![];

            for (log_idx, event) in tx.events.clone().iter().enumerate() {
                if event.kind.as_str().starts_with(Self::WASM_TYPE)
                    && event.attributes[0].value == addr
                {
                    available = true;
                } else if event.kind.as_str() != self.event_type {
                    continue;
                }

                let msg = parser(event.attributes.clone());
                let meta = LogMeta {
                    address: bech32_decode(addr.clone()),
                    block_number: block_number as u64,
                    block_hash: H256::from_slice(block.block_id.hash.as_bytes()),
                    transaction_id: H512::from_slice(tx_hash.clone().as_bytes()),
                    transaction_index: idx as u64,
                    log_index: U256::from(log_idx),
                };

                parse_result.push((msg, meta));
            }

            if available {
                result.extend(parse_result);
            }
        }

        Ok(result)
    }
}
