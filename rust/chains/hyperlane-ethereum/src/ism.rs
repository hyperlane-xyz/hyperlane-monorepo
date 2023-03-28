#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use ethers::providers::Middleware;
use tracing::instrument;

use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneAbi, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneProvider, Ism,
    H256,
};

use crate::contracts::i_interchain_security_module::{
    IInterchainSecurityModule as EthereumIsmInternal, IINTERCHAINSECURITYMODULE_ABI,
};
use crate::trait_builder::BuildableWithProvider;
use crate::EthereumProvider;

impl<M> std::fmt::Display for EthereumIsmInternal<M>
where
    M: Middleware,
{
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self)
    }
}

pub struct IsmBuilder {}

#[async_trait]
impl BuildableWithProvider for IsmBuilder {
    type Output = Box<dyn Ism>;

    async fn build_with_provider<M: Middleware + 'static>(
        &self,
        provider: M,
        locator: &ContractLocator,
    ) -> Self::Output {
        Box::new(EthereumIsm::new(Arc::new(provider), locator))
    }
}

/// A reference to an Ism contract on some Ethereum chain
#[derive(Debug)]
pub struct EthereumIsm<M>
where
    M: Middleware,
{
    contract: Arc<EthereumIsmInternal<M>>,
    domain: HyperlaneDomain,
}

impl<M> EthereumIsm<M>
where
    M: Middleware + 'static,
{
    /// Create a reference to a mailbox at a specific Ethereum address on some
    /// chain
    pub fn new(provider: Arc<M>, locator: &ContractLocator) -> Self {
        Self {
            contract: Arc::new(EthereumIsmInternal::new(locator.address, provider)),
            domain: locator.domain.clone(),
        }
    }
}

impl<M> HyperlaneChain for EthereumIsm<M>
where
    M: Middleware + 'static,
{
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(EthereumProvider::new(
            self.contract.client(),
            self.domain.clone(),
        ))
    }
}

impl<M> HyperlaneContract for EthereumIsm<M>
where
    M: Middleware + 'static,
{
    fn address(&self) -> H256 {
        self.contract.address().into()
    }
}

#[async_trait]
impl<M> Ism for EthereumIsm<M>
where
    M: Middleware + 'static,
{
    #[instrument(err, ret)]
    async fn module_type(
        &self
    ) -> ChainResult<u8> {
        let module_type = self
            .contract
            .module_type()
            .call()
            .await?;
        Ok(module_type)
    }
}

pub struct EthereumIsmAbi;

impl HyperlaneAbi for EthereumIsmAbi {
    const SELECTOR_SIZE_BYTES: usize = 4;

    fn fn_map() -> HashMap<Vec<u8>, &'static str> {
        super::extract_fn_map(&IINTERCHAINSECURITYMODULE_ABI)
    }
}
