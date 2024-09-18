use cosmrs::proto::tendermint::blocksync::BlockResponse;
use tendermint::Hash;
use tendermint_rpc::client::CompatMode;
use tendermint_rpc::endpoint::{block, block_by_hash, block_results, tx};
use tendermint_rpc::{Client, HttpClient};

use hyperlane_core::ChainResult;

use crate::{ConnectionConf, HyperlaneCosmosError};

/// Thin wrapper around Cosmos RPC client with error mapping
#[derive(Clone, Debug)]
pub struct CosmosRpcClient {
    client: HttpClient,
}

impl CosmosRpcClient {
    /// Create new `CosmosRpcClient`
    pub fn new(conf: &ConnectionConf) -> ChainResult<Self> {
        let client = HttpClient::builder(
            conf.get_rpc_url()
                .parse()
                .map_err(Into::<HyperlaneCosmosError>::into)?,
        )
        // Consider supporting different compatibility modes.
        .compat_mode(CompatMode::latest())
        .build()
        .map_err(Into::<HyperlaneCosmosError>::into)?;

        Ok(Self { client })
    }

    /// Request block by block height
    pub async fn get_block(&self, height: u32) -> ChainResult<block::Response> {
        Ok(self
            .client
            .block(height)
            .await
            .map_err(Into::<HyperlaneCosmosError>::into)?)
    }

    /// Request block results by block height
    pub async fn get_block_results(&self, height: u32) -> ChainResult<block_results::Response> {
        Ok(self
            .client
            .block_results(height)
            .await
            .map_err(Into::<HyperlaneCosmosError>::into)?)
    }

    /// Request block by block hash
    pub async fn get_block_by_hash(&self, hash: Hash) -> ChainResult<block_by_hash::Response> {
        Ok(self
            .client
            .block_by_hash(hash)
            .await
            .map_err(Into::<HyperlaneCosmosError>::into)?)
    }

    /// Request the latest block
    pub async fn get_latest_block(&self) -> ChainResult<block::Response> {
        Ok(self
            .client
            .latest_block()
            .await
            .map_err(Into::<HyperlaneCosmosError>::into)?)
    }

    /// Request transaction by transaction hash
    pub async fn get_tx_by_hash(&self, hash: Hash) -> ChainResult<tx::Response> {
        Ok(self
            .client
            .tx(hash, false)
            .await
            .map_err(Into::<HyperlaneCosmosError>::into)?)
    }
}
