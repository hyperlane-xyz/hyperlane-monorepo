#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use ethers::providers::Middleware;
use tracing::instrument;

use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneAbi, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneMessage, HyperlaneProvider, MultisigIsm, RawHyperlaneMessage, H256,
};

use crate::interfaces::i_multisig_ism::{
    IMultisigIsm as EthereumMultisigIsmInternal, IMULTISIGISM_ABI,
};
use crate::{BuildableWithProvider, ConnectionConf, EthereumProvider};

impl<M> std::fmt::Display for EthereumMultisigIsmInternal<M>
where
    M: Middleware,
{
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self)
    }
}

pub struct MultisigIsmBuilder {}

#[async_trait]
impl BuildableWithProvider for MultisigIsmBuilder {
    type Output = Box<dyn MultisigIsm>;
    const NEEDS_SIGNER: bool = false;

    async fn build_with_provider<M: Middleware + 'static>(
        &self,
        provider: M,
        _conn: &ConnectionConf,
        locator: &ContractLocator,
    ) -> Self::Output {
        Box::new(EthereumMultisigIsm::new(Arc::new(provider), locator))
    }
}

/// A reference to an MultisigIsm contract on some Ethereum chain
#[derive(Debug)]
pub struct EthereumMultisigIsm<M>
where
    M: Middleware,
{
    contract: Arc<EthereumMultisigIsmInternal<M>>,
    domain: HyperlaneDomain,
}

impl<M> EthereumMultisigIsm<M>
where
    M: Middleware + 'static,
{
    /// Create a reference to a mailbox at a specific Ethereum address on some
    /// chain
    pub fn new(provider: Arc<M>, locator: &ContractLocator) -> Self {
        Self {
            contract: Arc::new(EthereumMultisigIsmInternal::new(locator.address, provider)),
            domain: locator.domain.clone(),
        }
    }
}

impl<M> HyperlaneChain for EthereumMultisigIsm<M>
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

impl<M> HyperlaneContract for EthereumMultisigIsm<M>
where
    M: Middleware + 'static,
{
    fn address(&self) -> H256 {
        self.contract.address().into()
    }
}

#[async_trait]
impl<M> MultisigIsm for EthereumMultisigIsm<M>
where
    M: Middleware + 'static,
{
    #[instrument(err, skip(self, message))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn validators_and_threshold(
        &self,
        message: &HyperlaneMessage,
    ) -> ChainResult<(Vec<H256>, u8)> {
        let (validator_addresses, threshold) = self
            .contract
            .validators_and_threshold(RawHyperlaneMessage::from(message).to_vec().into())
            .call()
            .await?;
        let validators: Vec<H256> = validator_addresses.iter().map(|&x| H256::from(x)).collect();
        Ok((validators, threshold))
    }
}

pub struct EthereumMultisigIsmAbi;

impl HyperlaneAbi for EthereumMultisigIsmAbi {
    const SELECTOR_SIZE_BYTES: usize = 4;

    fn fn_map() -> HashMap<Vec<u8>, &'static str> {
        crate::extract_fn_map(&IMULTISIGISM_ABI)
    }
}
