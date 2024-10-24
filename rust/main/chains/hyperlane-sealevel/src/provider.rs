use std::sync::Arc;

use async_trait::async_trait;
use hyperlane_core::{
    BlockInfo, ChainInfo, ChainResult, HyperlaneChain, HyperlaneDomain, HyperlaneProvider,
    HyperlaneProviderError, TxnInfo, H256, H512, U256,
};

use crate::utils::{decode_h256, decode_pubkey};
use crate::{ConnectionConf, SealevelRpcClient};

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
    async fn get_block_by_height(&self, slot: u64) -> ChainResult<BlockInfo> {
        let confirmed_block = self.rpc_client.get_block(slot).await?;

        let block_hash = decode_h256(&confirmed_block.blockhash)?;

        let block_time = confirmed_block
            .block_time
            .ok_or(HyperlaneProviderError::CouldNotFindBlockByHeight(slot))?;

        let block_info = BlockInfo {
            hash: block_hash,
            timestamp: block_time as u64,
            number: slot,
        };

        Ok(block_info)
    }

    async fn get_txn_by_hash(&self, _hash: &H512) -> ChainResult<TxnInfo> {
        todo!() // FIXME
    }

    async fn is_contract(&self, _address: &H256) -> ChainResult<bool> {
        // FIXME
        Ok(true)
    }

    async fn get_balance(&self, address: String) -> ChainResult<U256> {
        let pubkey = decode_pubkey(&address)?;
        self.rpc_client.get_balance(&pubkey).await
    }

    async fn get_chain_metrics(&self) -> ChainResult<Option<ChainInfo>> {
        Ok(None)
    }
}
