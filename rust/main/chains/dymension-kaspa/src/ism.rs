use std::str::FromStr;

use super::consts::KASPA_ISM_ADDRESS;
use hyperlane_cosmos_rs::{
    hyperlane::core::interchain_security::v1::
        MerkleRootMultisigIsm
    ,
    prost::Name,
};
use tonic::async_trait;

use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneMessage, HyperlaneProvider, InterchainSecurityModule, ModuleType,
    MultisigIsm, RoutingIsm, H160, H256, U256,
};

use crate::{HyperlaneKaspaError, KaspaProvider};

/// Kaspa Native ISM
#[derive(Debug)]
pub struct KaspaIsm {
    /// The domain of the ISM contract.
    domain: HyperlaneDomain,
    /// The address of the ISM contract.
    address: H256,
    /// The provider for the ISM contract.
    provider: Box<KaspaProvider>,
}

/// The Kaspa Interchain Security Module Implementation.
impl KaspaIsm {
    /// Creates a new Kaspa Interchain Security Module.
    pub fn new(provider: KaspaProvider, locator: ContractLocator) -> ChainResult<Self> {
        Ok(Self {
            domain: locator.domain.clone(),
            address: locator.address,
            provider: Box::new(provider),
        })
    }
}

impl HyperlaneContract for KaspaIsm {
    /// Return the address of this contract
    fn address(&self) -> H256 {
        self.address
    }
}

impl HyperlaneChain for KaspaIsm {
    /// Return the Domain
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    /// A provider for the chain
    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        self.provider.clone()
    }
}

/// Interface for the InterchainSecurityModule chain contract. Allows abstraction over
/// different chains
#[async_trait]
impl InterchainSecurityModule for KaspaIsm {
    async fn module_type(&self) -> ChainResult<ModuleType> {
        Ok(ModuleType::KaspaMultisig)
    }

    async fn dry_run_verify(
        &self,
        _message: &HyperlaneMessage,
        _metadata: &[u8],
    ) -> ChainResult<Option<U256>> {
        // NOTE: is only relevant for aggeration isms -> kaspa native does not support them yet
        Ok(Some(1.into()))
    }
}

/// Interface for the MultisigIsm chain contract. Allows abstraction over
/// different chains
#[async_trait]
impl MultisigIsm for KaspaIsm {
    /// Returns the validator and threshold needed to verify message
    async fn validators_and_threshold(
        &self,
        _message: &HyperlaneMessage,
    ) -> ChainResult<(Vec<H256>, u8)> {
        let ism = self.get_ism().await?;
        match ism.type_url.as_str() {
            t if t == MerkleRootMultisigIsm::type_url() => {
                let ism = MerkleRootMultisigIsm::decode(ism.value.as_slice())
                    .map_err(HyperlaneKaspaError::from)?;
                let validators = ism
                    .validators
                    .iter()
                    .map(|v| H160::from_str(v).map(H256::from))
                    .collect::<Result<Vec<_>, _>>()?;
                Ok((validators, ism.threshold as u8))
            }
            _ => Err(ChainCommunicationError::from_other_str(&format!(
                "ISM {:?} not a multi sig ism",
                self.address
            ))),
        }
    }
}

/// Interface for the RoutingIsm chain contract. Allows abstraction over
/// different chains
#[async_trait]
impl RoutingIsm for KaspaIsm {
    /// Returns the ISM needed to verify message
    async fn route(&self, message: &HyperlaneMessage) -> ChainResult<H256> {
        // We are only bridging Dymension to Kaspa
        Ok(KASPA_ISM_ADDRESS)
    }
}
