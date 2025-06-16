use std::ops::Deref;

use derive_new::new;
use tonic::async_trait;

use hyperlane_core::{
    rpc_clients::FallbackProvider,
    BlockInfo, ChainInfo, ChainResult,
    ContractLocator, HyperlaneChain, HyperlaneDomain, HyperlaneProvider,
    HyperlaneProviderError, TxnInfo, H256, H512,
    U256,
};

use crate::{
    ConnectionConf, Signer,
};


/// Wrapper of `FallbackProvider` for use in `hyperlane-kaspa-native`
#[derive(new, Clone)]
pub(crate) struct KaspaFallbackProvider<T> {
    fallback_provider: FallbackProvider<T, T>,
}

impl<T> Deref for KaspaFallbackProvider<T> {
    type Target = FallbackProvider<T, T>;

    fn deref(&self) -> &Self::Target {
        &self.fallback_provider
    }
}

impl<C> std::fmt::Debug for KaspaFallbackProvider<C>
where
    C: std::fmt::Debug,
{
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.fallback_provider.fmt(f)
    }
}

#[derive(Debug, Clone)]
pub struct KaspaProvider 
{
    domain: HyperlaneDomain,

}

impl KaspaProvider {
    pub fn new(
        conf: &ConnectionConf,
        locator: &ContractLocator,
        signer: Option<Signer>,
    ) -> ChainResult<Self> {
        Ok(KaspaProvider {
            domain: locator.domain.clone(),
        })
    }
    pub fn rpc(&self) -> RpcProvider {
        RpcProvider::new(self.conf.clone(), self.locator.clone(), self.signer.clone())
    }
}

impl HyperlaneChain for KaspaProvider {
    /// Return the domain
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    /// A provider for the chain
    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.clone())
    }
}

#[async_trait]
impl HyperlaneProvider for KaspaProvider {
    // only used by scraper
    async fn get_block_by_height(&self, height: u64) -> ChainResult<BlockInfo> {
        Err(HyperlaneProviderError::CouldNotFindBlockByHeight(height).into())
    }

    // only used by scraper
    async fn get_txn_by_hash(&self, hash: &H512) -> ChainResult<TxnInfo> {
        return Err(HyperlaneProviderError::CouldNotFindTransactionByHash(*hash).into());
    }

    async fn is_contract(&self, _address: &H256) -> ChainResult<bool> {
        // TODO: check if the address is a recipient (this is a hyperlane team todo)
        return Ok(true);
    }

    async fn get_balance(&self, address: String) -> ChainResult<U256> {
        // TODO: maybe I can return just a larger number here?
       return Ok(0.into()) 
    }

    async fn get_chain_metrics(&self) -> ChainResult<Option<ChainInfo>> {
        return Ok(None);
    }
}
