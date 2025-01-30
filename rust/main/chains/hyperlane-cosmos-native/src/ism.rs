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

    async fn get_ism(&self) -> ChainResult<Option<ISM>> {
        let isms = self.provider.rest().isms(ReorgPeriod::None).await?;
        for ism in isms {
            match ism.clone() {
                ISM::NoOpISM { id, .. } if id.parse::<H256>()? == self.address => {
                    return Ok(Some(ism))
                }
                ISM::MultiSigISM { id, .. } if id.parse::<H256>()? == self.address => {
                    return Ok(Some(ism))
                }
                _ => {}
            }
        }

        Ok(None)
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
        let isms = self.provider.rest().isms(ReorgPeriod::None).await?;
        for ism in isms {
            match ism {
                ISM::NoOpISM { id, .. } if id.parse::<H256>()? == self.address => {
                    return Ok(ModuleType::Null)
                }
                ISM::MultiSigISM { id, .. } if id.parse::<H256>()? == self.address => {
                    return Ok(ModuleType::MerkleRootMultisig)
                }
                _ => {}
            }
        }
        Err(ChainCommunicationError::from_other_str(
            "cannot convert ism to contract type",
        ))
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
        let ism = self.get_ism().await?.ok_or_else(|| {
            ChainCommunicationError::from_other_str("ism contract does not exists on chain")
        })?;

        match ism {
            ISM::MultiSigISM {
                id,
                creator,
                ism_type,
                multi_sig,
            } => {
                let validators = multi_sig
                    .validator_pub_keys
                    .iter()
                    .map(|v| H160::from_str(v).map(H256::from))
                    .collect::<Result<Vec<_>, _>>()?;
                Ok((validators, multi_sig.threshold as u8))
            }
            _ => Err(ChainCommunicationError::from_other_str(
                "ISM address is not a MultiSigISM",
            )),
        }
    }
}
