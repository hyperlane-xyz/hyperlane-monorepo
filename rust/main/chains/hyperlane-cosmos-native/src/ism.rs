use core::panic;
use std::str::FromStr;

use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneMessage, HyperlaneProvider, InterchainSecurityModule, ModuleType,
    MultisigIsm, ReorgPeriod, H160, H256, U256,
};
use tonic::async_trait;

use crate::{ConnectionConf, CosmosNativeProvider, Signer, ISM};

/// Cosmos Native ISM
#[derive(Debug)]
pub struct CosmosNativeIsm {
    /// The domain of the ISM contract.
    domain: HyperlaneDomain,
    /// The address of the ISM contract.
    address: H256,
    /// The provider for the ISM contract.
    provider: Box<CosmosNativeProvider>,
}

/// The Cosmos Interchain Security Module Implementation.
impl CosmosNativeIsm {
    /// Creates a new Cosmos Interchain Security Module.
    pub fn new(conf: &ConnectionConf, locator: ContractLocator) -> ChainResult<Self> {
        let provider =
            CosmosNativeProvider::new(locator.domain.clone(), conf.clone(), locator.clone(), None)?;

        Ok(Self {
            domain: locator.domain.clone(),
            address: locator.address,
            provider: Box::new(provider),
        })
    }

    async fn get_ism(&self) -> ChainResult<ISM> {
        self.provider
            .rest()
            .ism(self.address.clone(), ReorgPeriod::None)
            .await
    }
}

impl HyperlaneContract for CosmosNativeIsm {
    /// Return the address of this contract
    fn address(&self) -> H256 {
        self.address.clone()
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
        match ism {
            ISM::MultiSigISM { .. } => Ok(ModuleType::MerkleRootMultisig),
            ISM::NoOpISM { .. } => Ok(ModuleType::Null),
        }
    }

    /// Dry runs the `verify()` ISM call and returns `Some(gas_estimate)` if the call
    /// succeeds.
    async fn dry_run_verify(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
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
        message: &HyperlaneMessage,
    ) -> ChainResult<(Vec<H256>, u8)> {
        let ism = self.get_ism().await?;

        match ism {
            ISM::MultiSigISM {
                type_url,
                id,
                owner,
                validators,
                threshold,
            } => {
                let validators = validators
                    .iter()
                    .map(|v| H160::from_str(v).map(H256::from))
                    .collect::<Result<Vec<_>, _>>()?;
                Ok((validators, threshold as u8))
            }
            e => Err(ChainCommunicationError::from_other_str(&format!(
                "ISM {:?} not a multi sig ism",
                self.address
            ))),
        }
    }
}
