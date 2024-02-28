use std::{str::FromStr, sync::Arc};

use async_trait::async_trait;

use hyperlane_core::{
    BlockInfo, ChainInfo, ChainResult, HyperlaneChain, HyperlaneDomain, HyperlaneProvider, TxnInfo,
    H256, U256,
};
use solana_sdk::{commitment_config::CommitmentConfig, pubkey::Pubkey};

use crate::{client::RpcClientWithDebug, error::HyperlaneSealevelError, ConnectionConf};

/// A wrapper around a Sealevel provider to get generic blockchain information.
#[derive(Debug)]
pub struct SealevelProvider {
    domain: HyperlaneDomain,
    rpc_client: Arc<RpcClientWithDebug>,
}

impl SealevelProvider {
    /// Create a new Sealevel provider.
    pub fn new(domain: HyperlaneDomain, conf: &ConnectionConf) -> Self {
        // Set the `processed` commitment at rpc level
        let rpc_client = Arc::new(RpcClientWithDebug::new_with_commitment(
            conf.url.to_string(),
            CommitmentConfig::processed(),
        ));

        SealevelProvider { domain, rpc_client }
    }

    /// Get an rpc client
    pub fn rpc(&self) -> &RpcClientWithDebug {
        &self.rpc_client
    }

    /// Get the balance of an address
    pub async fn get_balance(&self, address: String) -> ChainResult<U256> {
        let pubkey = Pubkey::from_str(&address).map_err(Into::<HyperlaneSealevelError>::into)?;
        let balance = self
            .rpc_client
            .get_balance(&pubkey)
            .await
            .map_err(Into::<HyperlaneSealevelError>::into)?;
        Ok(balance.into())
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
    async fn get_block_by_hash(&self, _hash: &H256) -> ChainResult<BlockInfo> {
        todo!() // FIXME
    }

    async fn get_txn_by_hash(&self, _hash: &H256) -> ChainResult<TxnInfo> {
        todo!() // FIXME
    }

    async fn is_contract(&self, _address: &H256) -> ChainResult<bool> {
        // FIXME
        Ok(true)
    }

    async fn get_balance(&self, address: String) -> ChainResult<U256> {
        self.get_balance(address).await
    }

    async fn get_chain_metrics(&self) -> ChainResult<Option<ChainInfo>> {
        Ok(None)
    }
}
