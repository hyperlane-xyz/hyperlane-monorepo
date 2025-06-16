use std::ops::Deref;

use async_trait::async_trait;
use hyperlane_core::{
    BlockInfo, ChainCommunicationError, ChainInfo, ChainResult, HyperlaneChain, HyperlaneDomain,
    HyperlaneProvider, TxnInfo, H256, H512, U256,
};

mod client;
mod methods;
mod transaction;

use crate::{ConnectionConf, Signer};
pub use client::SovereignClient;

/// A wrapper around a Sovereign provider to get generic blockchain information.
#[derive(Debug, Clone)]
pub struct SovereignProvider {
    domain: HyperlaneDomain,
    client: SovereignClient,
}

impl SovereignProvider {
    /// Create a new `SovereignProvider`.
    pub async fn new(
        domain: HyperlaneDomain,
        conf: &ConnectionConf,
        signer: Option<Signer>,
    ) -> ChainResult<Self> {
        let signer = signer.ok_or(ChainCommunicationError::SignerUnavailable)?;
        let client = SovereignClient::new(conf, signer).await?;

        Ok(Self { domain, client })
    }
}

impl Deref for SovereignProvider {
    type Target = SovereignClient;

    fn deref(&self) -> &Self::Target {
        &self.client
    }
}

impl HyperlaneChain for SovereignProvider {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.clone())
    }
}

// Initial implementation of the Sovereign chain does not include the Scraper as it is not a necessary component for cross chain relaying.
#[async_trait]
impl HyperlaneProvider for SovereignProvider {
    async fn get_block_by_height(&self, _height: u64) -> ChainResult<BlockInfo> {
        Err(custom_err!("Not supported"))
    }

    async fn get_txn_by_hash(&self, _hash: &H512) -> ChainResult<TxnInfo> {
        Err(custom_err!("Not supported"))
    }

    async fn is_contract(&self, _address: &H256) -> ChainResult<bool> {
        Ok(true)
    }

    async fn get_balance(&self, _address: String) -> ChainResult<U256> {
        Err(custom_err!("Not supported"))
    }

    async fn get_chain_metrics(&self) -> ChainResult<Option<ChainInfo>> {
        Err(custom_err!("Not supported"))
    }
}
