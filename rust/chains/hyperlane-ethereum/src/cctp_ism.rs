#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use ethers::providers::Middleware;
use tracing::instrument;

use hyperlane_core::{
    CctpIsm, ChainResult, ContractLocator, HyperlaneAbi, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneProvider, H256,
};

pub use crate::contracts::i_cctp_ism::{
    ICctpIsm as EthereumCctpIsmInternal, OffchainLookup, ICCTPISM_ABI,
};
use crate::trait_builder::BuildableWithProvider;
use crate::EthereumProvider;

pub struct CctpIsmBuilder {}

#[async_trait]
impl BuildableWithProvider for CctpIsmBuilder {
    type Output = Box<dyn CctpIsm>;

    async fn build_with_provider<M: Middleware + 'static>(
        &self,
        provider: M,
        locator: &ContractLocator,
    ) -> Self::Output {
        Box::new(EthereumCctpIsm::new(Arc::new(provider), locator))
    }
}

/// A reference to an CcipReadIsm contract on some Ethereum chain
#[derive(Debug)]
pub struct EthereumCctpIsm<M>
where
    M: Middleware,
{
    contract: Arc<EthereumCctpIsmInternal<M>>,
    domain: HyperlaneDomain,
}

impl<M> EthereumCctpIsm<M>
where
    M: Middleware + 'static,
{
    /// Create a reference to a mailbox at a specific Ethereum address on some
    /// chain
    pub fn new(provider: Arc<M>, locator: &ContractLocator) -> Self {
        Self {
            contract: Arc::new(EthereumCctpIsmInternal::new(locator.address, provider)),
            domain: locator.domain.clone(),
        }
    }
}

impl<M> HyperlaneChain for EthereumCctpIsm<M>
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

impl<M> HyperlaneContract for EthereumCctpIsm<M>
where
    M: Middleware + 'static,
{
    fn address(&self) -> H256 {
        self.contract.address().into()
    }
}

#[async_trait]
impl<M> CctpIsm for EthereumCctpIsm<M>
where
    M: Middleware + 'static,
{
    #[instrument(err)]
    async fn get_offchain_verify_info(&self, message: Vec<u8>) -> ChainResult<bool> {
        let info: bool = self
            .contract
            .get_offchain_verify_info(message.into())
            .call()
            .await?;
        Ok(info)
    }
}

pub struct EthereumCctpIsmAbi;

impl HyperlaneAbi for EthereumCctpIsmAbi {
    const SELECTOR_SIZE_BYTES: usize = 4;

    fn fn_map() -> HashMap<Vec<u8>, &'static str> {
        super::extract_fn_map(&ICCTPISM_ABI)
    }
}