#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use ethers::providers::Middleware;

use hyperlane_core::{
    ValidatorAnnounce,
    ChainResult, ContractLocator, HyperlaneAbi, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    H160, H256,
};

use crate::contracts::validator_announce::{
    ValidatorAnnounce as EthereumValidatorAnnounceInternal, VALIDATORANNOUNCE_ABI,
};
use crate::trait_builder::BuildableWithProvider;

impl<M> std::fmt::Display for EthereumValidatorAnnounceInternal<M>
where
    M: Middleware,
{
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self)
    }
}

pub struct ValidatorAnnounceBuilder {}

#[async_trait]
impl BuildableWithProvider for ValidatorAnnounceBuilder {
    type Output = Box<dyn ValidatorAnnounce>;

    async fn build_with_provider<M: Middleware + 'static>(
        &self,
        provider: M,
        locator: &ContractLocator,
    ) -> Self::Output {
        Box::new(EthereumValidatorAnnounce::new(Arc::new(provider), locator))
    }
}

/// A reference to an ValidatorAnnounce contract on some Ethereum chain
#[derive(Debug)]
pub struct EthereumValidatorAnnounce<M>
where
    M: Middleware,
{
    contract: Arc<EthereumValidatorAnnounceInternal<M>>,
    domain: HyperlaneDomain,
}

impl<M> EthereumValidatorAnnounce<M>
where
    M: Middleware + 'static,
{
    /// Create a reference to a mailbox at a specific Ethereum address on some
    /// chain
    pub fn new(provider: Arc<M>, locator: &ContractLocator) -> Self {
        Self {
            contract: Arc::new(EthereumValidatorAnnounceInternal::new(
                locator.address,
                provider,
            )),
            domain: locator.domain.clone(),
        }
    }
}

impl<M> HyperlaneChain for EthereumValidatorAnnounce<M>
where
    M: Middleware + 'static,
{
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }
}

impl<M> HyperlaneContract for EthereumValidatorAnnounce<M>
where
    M: Middleware + 'static,
{
    fn address(&self) -> H256 {
        self.contract.address().into()
    }
}

#[async_trait]
impl<M> ValidatorAnnounce for EthereumValidatorAnnounce<M>
where
    M: Middleware + 'static,
{
    async fn get_announced_storage_locations(
        &self,
        validators: &[H256],
    ) -> ChainResult<Vec<Vec<String>>> {
        let storage_locations = self
            .contract
            .get_announced_storage_locations(validators.iter().map(|v| H160::from(*v)).collect())
            .call()
            .await?;
        Ok(storage_locations)
    }
}

pub struct EthereumValidatorAnnounceAbi;

impl HyperlaneAbi for EthereumValidatorAnnounceAbi {
    const SELECTOR_SIZE_BYTES: usize = 4;

    fn fn_map() -> HashMap<Vec<u8>, &'static str> {
        super::extract_fn_map(&VALIDATORANNOUNCE_ABI)
    }
}
