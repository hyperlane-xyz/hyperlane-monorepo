use async_trait::async_trait;
use ethers::providers::Middleware;
use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneAbi, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneMessage, HyperlaneProvider, RawHyperlaneMessage, WeightedMultisigIsm, H256,
};
use std::collections::HashMap;
use std::sync::Arc;
use tracing::instrument;

use crate::{BuildableWithProvider, ConnectionConf, EthereumProvider};

use crate::interfaces::i_static_weighted_multisig_ism::{
    IStaticWeightedMultisigIsm as EthereumWeightedMultisigIsmInternal,
    ISTATICWEIGHTEDMULTISIGISM_ABI,
};

/// Builder for WeightedMultisigIsm contracts
pub struct WeighedMultisigIsmBuilder {}

#[async_trait]
impl BuildableWithProvider for WeighedMultisigIsmBuilder {
    type Output = Box<dyn WeightedMultisigIsm>;
    const NEEDS_SIGNER: bool = false;

    async fn build_with_provider<M: Middleware + 'static>(
        &self,
        provider: M,
        _conn: &ConnectionConf,
        locator: &ContractLocator,
    ) -> Self::Output {
        Box::new(EthereumWeightedMultisigIsm::new(
            Arc::new(provider),
            locator,
        ))
    }
}

/// A reference to an WeightedMultisigIsm contract on some Ethereum chain
#[derive(Debug)]
pub struct EthereumWeightedMultisigIsm<M>
where
    M: Middleware,
{
    contract: Arc<EthereumWeightedMultisigIsmInternal<M>>,
    domain: HyperlaneDomain,
}

impl<M> EthereumWeightedMultisigIsm<M>
where
    M: Middleware + 'static,
{
    /// Create a reference to a mailbox at a specific Ethereum address on some
    /// chain
    pub fn new(provider: Arc<M>, locator: &ContractLocator) -> Self {
        Self {
            contract: Arc::new(EthereumWeightedMultisigIsmInternal::new(
                locator.address,
                provider,
            )),
            domain: locator.domain.clone(),
        }
    }
}

impl<M> HyperlaneChain for EthereumWeightedMultisigIsm<M>
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

impl<M> HyperlaneContract for EthereumWeightedMultisigIsm<M>
where
    M: Middleware + 'static,
{
    fn address(&self) -> H256 {
        self.contract.address().into()
    }
}

#[async_trait]
impl<M> WeightedMultisigIsm for EthereumWeightedMultisigIsm<M>
where
    M: Middleware + 'static,
{
    #[instrument(err)]
    async fn validators_and_threshold_weight(
        &self,
        message: &HyperlaneMessage,
    ) -> ChainResult<(Vec<(H256, u128)>, u128)> {
        let (validator_addresses, threshold) = self
            .contract
            .validators_and_threshold_weight(RawHyperlaneMessage::from(message).to_vec().into())
            .call()
            .await?;
        let validators: Vec<(H256, u128)> = validator_addresses
            .iter()
            .map(|x| (H256::from(x.signing_address), x.weight))
            .collect();
        Ok((validators, threshold))
    }
}

/// ABI for WeightedMultisigIsm contracts
pub struct EthereumWeightedMultisigIsmAbi;

impl HyperlaneAbi for EthereumWeightedMultisigIsmAbi {
    const SELECTOR_SIZE_BYTES: usize = 4;

    fn fn_map() -> HashMap<Vec<u8>, &'static str> {
        crate::extract_fn_map(&ISTATICWEIGHTEDMULTISIGISM_ABI)
    }
}
