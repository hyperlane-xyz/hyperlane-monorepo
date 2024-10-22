use std::{str::FromStr, sync::Arc};

use async_trait::async_trait;
use hyperlane_core::{
    BlockInfo, ChainInfo, ChainResult, HyperlaneChain, HyperlaneDomain, HyperlaneProvider,
    HyperlaneProviderError, TxnInfo, H256, U256,
};
use solana_sdk::pubkey::Pubkey;

use crate::{error::HyperlaneSealevelError, ConnectionConf, SealevelRpcClient};

/// A wrapper around a Sealevel provider to get generic blockchain information.
#[derive(Debug)]
pub struct SealevelProvider {
    domain: HyperlaneDomain,
    rpc_client: Arc<SealevelRpcClient>,
}

impl SealevelProvider {
    /// Create a new Sealevel provider.
    pub fn new(domain: HyperlaneDomain, conf: &ConnectionConf) -> Self {
        // Set the `processed` commitment at rpc level
        let rpc_client = Arc::new(SealevelRpcClient::new(conf.url.to_string()));

        SealevelProvider { domain, rpc_client }
    }

    /// Get an rpc client
    pub fn rpc(&self) -> &SealevelRpcClient {
        &self.rpc_client
    }
}

impl HyperlaneChain for SealevelProvider {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(SealevelProvider {
            domain: self.domain.clone(),
            rpc_client: self.rpc_client.clone(),
        })
    }
}

#[async_trait]
impl HyperlaneProvider for SealevelProvider {
    async fn get_block_by_height(&self, height: u64) -> ChainResult<BlockInfo> {
        let confirmed_block = self.rpc_client.get_block(height).await?;
        let block_hash = H256::from_str(&confirmed_block.blockhash)?;

        let block_info = match (confirmed_block.block_height, confirmed_block.block_time) {
            (Some(block_height), Some(block_time)) => BlockInfo {
                hash: block_hash,
                timestamp: block_time as u64,
                number: block_height,
            },
            _ => Err(HyperlaneProviderError::CouldNotFindBlockByHeight(height))?,
        };

        if block_info.number != height {
            Err(HyperlaneProviderError::IncorrectBlockByHeight(
                height,
                block_info.number,
            ))?
        }

        Ok(block_info)
    }

    async fn get_txn_by_hash(&self, _hash: &H256) -> ChainResult<TxnInfo> {
        todo!() // FIXME
    }

    async fn is_contract(&self, _address: &H256) -> ChainResult<bool> {
        // FIXME
        Ok(true)
    }

    async fn get_balance(&self, address: String) -> ChainResult<U256> {
        let pubkey = Pubkey::from_str(&address).map_err(Into::<HyperlaneSealevelError>::into)?;
        self.rpc_client.get_balance(&pubkey).await
    }

    async fn get_chain_metrics(&self) -> ChainResult<Option<ChainInfo>> {
        Ok(None)
    }
}
