#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use async_trait::async_trait;

use crate::contracts::optimism_ism::{
    OptimismISM as EthereumOptimismISMInternal, OPTIMISMISM_ABI,
};

use crate::trait_builder::BuildableWithProvider;
use ethers::providers::Middleware;

pub struct OptimismISMBuilder {}


#[async_trait]
impl BuildableWithProvider for OptimismISMBuilder {
    type Output = Box<dyn OptimismISM>;

    async fn build_with_provider<M: Middleware + 'static>(
        &self,
        provider: M,
        locator: &ContractLocator,
    ) -> Self::Output {
        Box::new(EthereumOptimismISM::new(Arc::new(provider), locator))
    }
}

/// A reference to an OptimismISM contract on some Optimism chain
#[derive(Debug)]
pub struct EthereumOptimismISM<M>
where
    M: Middleware,
{
    contract: Arc<EthereumOptimismISMInternal<M>>,
    domain: HyperlaneDomain,
}

impl<M> EthereumOptimismISM<M>
where
    M: Middleware + 'static,
{
    /// Create a reference to a mailbox at a specific Ethereum address on some
    /// chain
    pub fn new(provider: Arc<M>, locator: &ContractLocator) -> Self {
        Self {
            contract: Arc::new(EthereumOptimismISMInternal::new(locator.address, provider)),
            domain: locator.domain.clone(),
        }
    }
}


