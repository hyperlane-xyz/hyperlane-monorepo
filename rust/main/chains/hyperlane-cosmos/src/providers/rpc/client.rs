use cosmrs::proto::tendermint::blocksync::BlockResponse;
use hyperlane_core::rpc_clients::BlockNumberGetter;
use tendermint::Hash;
use tendermint_rpc::client::CompatMode;
use tendermint_rpc::endpoint::{block, block_by_hash, block_results, tx};
use tendermint_rpc::{Client, HttpClient, HttpClientUrl, Url as TendermintUrl};

use hyperlane_core::{ChainCommunicationError, ChainResult};
use tonic::async_trait;
use url::Url;

use crate::{ConnectionConf, HyperlaneCosmosError};

/// Thin wrapper around Cosmos RPC client with error mapping
#[derive(Clone, Debug)]
pub struct CosmosRpcClient {
    client: HttpClient,
}

impl CosmosRpcClient {
    /// Create new `CosmosRpcClient`
    pub fn new(url: &Url) -> ChainResult<Self> {
        let tendermint_url = tendermint_rpc::Url::try_from(url.to_owned())
            .map_err(Into::<HyperlaneCosmosError>::into)?;
        let url = tendermint_rpc::HttpClientUrl::try_from(tendermint_url)
            .map_err(Into::<HyperlaneCosmosError>::into)?;

        let client = HttpClient::builder(url)
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

#[async_trait]
impl BlockNumberGetter for CosmosRpcClient {
    async fn get_block_number(&self) -> Result<u64, ChainCommunicationError> {
        self.get_latest_block()
            .await
            .map(|block| block.block.header.height.value())
    }
}
