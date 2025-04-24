use std::str::FromStr;

use cosmrs::Any;
use hex::ToHex;
use hyperlane_cosmos_rs::{
    hyperlane::core::interchain_security::v1::{MerkleRootMultisigIsm, NoopIsm},
    prost::{Message, Name},
};
use tonic::async_trait;

use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneMessage, HyperlaneProvider, InterchainSecurityModule, ModuleType,
    MultisigIsm, H160, H256, U256,
};

use crate::{CosmosProvider, HyperlaneCosmosError};

use super::module_query_client::ModuleQueryClient;

/// Cosmos Native ISM
#[derive(Debug)]
pub struct CosmosNativeIsm {
    /// The domain of the ISM contract.
    domain: HyperlaneDomain,
    /// The address of the ISM contract.
    address: H256,
    /// The provider for the ISM contract.
    provider: Box<CosmosProvider<ModuleQueryClient>>,
}

/// The Cosmos Interchain Security Module Implementation.
impl CosmosNativeIsm {
    /// Creates a new Cosmos Interchain Security Module.
    pub fn new(
        provider: CosmosProvider<ModuleQueryClient>,
        locator: ContractLocator,
    ) -> ChainResult<Self> {
        Ok(Self {
            domain: locator.domain.clone(),
            address: locator.address,
            provider: Box::new(provider),
        })
    }

    async fn get_ism(&self) -> ChainResult<Any> {
        let ism = self.provider.query().ism(self.address.encode_hex()).await?;
        ism.ism.ok_or_else(|| {
            ChainCommunicationError::from_other_str(&format!(
                "Empty ism response for: {:?}",
                self.address
            ))
        })
    }
}

impl HyperlaneContract for CosmosNativeIsm {
    /// Return the address of this contract
    fn address(&self) -> H256 {
        self.address
    }
}

impl HyperlaneChain for CosmosNativeIsm {
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
impl InterchainSecurityModule for CosmosNativeIsm {
    /// Returns the module type of the ISM compliant with the corresponding
    /// metadata offchain fetching and onchain formatting standard.
    async fn module_type(&self) -> ChainResult<ModuleType> {
        let ism = self.get_ism().await?;
        match ism.type_url.as_str() {
            t if t == MerkleRootMultisigIsm::type_url() => Ok(ModuleType::MerkleRootMultisig),
            t if t == NoopIsm::type_url() => Ok(ModuleType::Null),
            other => Err(ChainCommunicationError::from_other_str(&format!(
                "Unknown ISM type: {}",
                other
            ))),
        }
    }

    /// Dry runs the `verify()` ISM call and returns `Some(gas_estimate)` if the call
    /// succeeds.
    async fn dry_run_verify(
        &self,
        _message: &HyperlaneMessage,
        _metadata: &[u8],
    ) -> ChainResult<Option<U256>> {
        // NOTE: is only relevant for aggeration isms -> cosmos native does not support them yet
        Ok(Some(1.into()))
    }
}

/// Interface for the MultisigIsm chain contract. Allows abstraction over
/// different chains
#[async_trait]
impl MultisigIsm for CosmosNativeIsm {
    /// Returns the validator and threshold needed to verify message
    async fn validators_and_threshold(
        &self,
        _message: &HyperlaneMessage,
    ) -> ChainResult<(Vec<H256>, u8)> {
        let ism = self.get_ism().await?;
        match ism.type_url.as_str() {
            t if t == MerkleRootMultisigIsm::type_url() => {
                let ism = MerkleRootMultisigIsm::decode(ism.value.as_slice())
                    .map_err(HyperlaneCosmosError::from)?;
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
