#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use ethers::providers::Middleware;
use tracing::{instrument, warn};

use futures_util::future::try_join;
use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneAbi, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneMessage, HyperlaneProvider, InterchainSecurityModule, ModuleType, RawHyperlaneMessage,
    H256, U256,
};
use num_traits::cast::FromPrimitive;

use crate::contracts::i_interchain_security_module::{
    IInterchainSecurityModule as EthereumInterchainSecurityModuleInternal,
    IINTERCHAINSECURITYMODULE_ABI,
};
use crate::trait_builder::BuildableWithProvider;
use crate::{ConnectionConf, EthereumProvider};

pub struct InterchainSecurityModuleBuilder {}

#[async_trait]
impl BuildableWithProvider for InterchainSecurityModuleBuilder {
    type Output = Box<dyn InterchainSecurityModule>;

    async fn build_with_provider<M: Middleware + 'static>(
        &self,
        provider: M,
        _conn: &ConnectionConf,
        locator: &ContractLocator,
    ) -> Self::Output {
        Box::new(EthereumInterchainSecurityModule::new(
            Arc::new(provider),
            locator,
        ))
    }
}

/// A reference to an InterchainSecurityModule contract on some Ethereum chain
#[derive(Debug)]
pub struct EthereumInterchainSecurityModule<M>
where
    M: Middleware,
{
    contract: Arc<EthereumInterchainSecurityModuleInternal<M>>,
    domain: HyperlaneDomain,
}

impl<M> EthereumInterchainSecurityModule<M>
where
    M: Middleware + 'static,
{
    /// Create a reference to a mailbox at a specific Ethereum address on some
    /// chain
    pub fn new(provider: Arc<M>, locator: &ContractLocator) -> Self {
        Self {
            contract: Arc::new(EthereumInterchainSecurityModuleInternal::new(
                locator.address,
                provider,
            )),
            domain: locator.domain.clone(),
        }
    }
}

impl<M> HyperlaneChain for EthereumInterchainSecurityModule<M>
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

impl<M> HyperlaneContract for EthereumInterchainSecurityModule<M>
where
    M: Middleware + 'static,
{
    fn address(&self) -> H256 {
        self.contract.address().into()
    }
}

#[async_trait]
impl<M> InterchainSecurityModule for EthereumInterchainSecurityModule<M>
where
    M: Middleware + 'static,
{
    #[instrument]
    async fn module_type(&self) -> ChainResult<ModuleType> {
        let module = self.contract.module_type().call().await?;
        if let Some(module_type) = ModuleType::from_u8(module) {
            Ok(module_type)
        } else {
            warn!(%module, "Unknown module type");
            Ok(ModuleType::Unused)
        }
    }

    #[instrument]
    async fn dry_run_verify(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
    ) -> ChainResult<Option<U256>> {
        let tx = self.contract.verify(
            metadata.to_owned().into(),
            RawHyperlaneMessage::from(message).to_vec().into(),
        );
        let (verifies, gas_estimate) = try_join(tx.call(), tx.estimate_gas()).await?;
        if verifies {
            Ok(Some(gas_estimate.into()))
        } else {
            Ok(None)
        }
    }
}

pub struct EthereumInterchainSecurityModuleAbi;

impl HyperlaneAbi for EthereumInterchainSecurityModuleAbi {
    const SELECTOR_SIZE_BYTES: usize = 4;

    fn fn_map() -> HashMap<Vec<u8>, &'static str> {
        super::extract_fn_map(&IINTERCHAINSECURITYMODULE_ABI)
    }
}
