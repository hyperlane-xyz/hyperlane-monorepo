use async_trait::async_trait;
use num_traits::cast::FromPrimitive;
use snarkvm::prelude::Itertools;
use snarkvm::prelude::{Address, FromBytes};

use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneMessage, HyperlaneProvider, InterchainSecurityModule, ModuleType,
    MultisigIsm, RoutingIsm, H160, H256, U256,
};

use crate::utils::to_h256;
use crate::{
    AleoMessagesIdMultisig, AleoProvider, ConnectionConf, CurrentNetwork, HyperlaneAleoError,
    RouteKey,
};

/// Aleo Ism
#[derive(Debug, Clone)]
pub struct AleoIsm {
    provider: AleoProvider,
    address: H256,
    program: String,
    aleo_address: Address<CurrentNetwork>,
    domain: HyperlaneDomain,
}

impl AleoIsm {
    /// Aleo ISM
    pub fn new(
        provider: AleoProvider,
        locator: &ContractLocator,
        conf: &ConnectionConf,
    ) -> ChainResult<Self> {
        let aleo_address = Address::<CurrentNetwork>::from_bytes_le(locator.address.as_bytes())
            .map_err(HyperlaneAleoError::from)?;
        Ok(Self {
            provider,
            address: locator.address,
            program: conf.ism_manager_program.clone(),
            aleo_address,
            domain: locator.domain.clone(),
        })
    }
}

impl HyperlaneChain for AleoIsm {
    /// Return the domain
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    /// A provider for the chain
    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

impl HyperlaneContract for AleoIsm {
    /// Address
    fn address(&self) -> H256 {
        self.address
    }
}

#[async_trait]
impl InterchainSecurityModule for AleoIsm {
    /// Returns the module type of the ISM compliant with the corresponding
    /// metadata offchain fetching and onchain formatting standard.
    async fn module_type(&self) -> ChainResult<ModuleType> {
        let module_type: u8 = self
            .provider
            .get_mapping_value(&self.program, "isms", &self.aleo_address)
            .await?;
        ModuleType::from_u8(module_type).ok_or_else(|| {
            ChainCommunicationError::from_other_str(&format!(
                "Failed to convert to ModuleType: {module_type}"
            ))
        })
    }

    /// Dry runs the `verify()` ISM call and returns `Some(gas_estimate)` if the call
    /// succeeds.
    async fn dry_run_verify(
        &self,
        _message: &HyperlaneMessage,
        _metadata: &[u8],
    ) -> ChainResult<Option<U256>> {
        // Aleo currently doesn't support aggregation ISMs
        // Only in the case of an aggregation ISM is this method used
        Ok(Some(U256::one()))
    }
}

#[async_trait]
impl MultisigIsm for AleoIsm {
    /// Returns the validator and threshold needed to verify message
    async fn validators_and_threshold(
        &self,
        _message: &HyperlaneMessage,
    ) -> ChainResult<(Vec<H256>, u8)> {
        // There are only message_id_multisigs in Aleo ISMs
        let multisig_ism: AleoMessagesIdMultisig = self
            .provider
            .get_mapping_value(&self.program, "message_id_multisigs", &self.aleo_address)
            .await?;
        let validators = multisig_ism
            .validators
            .iter()
            .map(|validator| {
                let validator = H160::from(validator.bytes);
                H256::from(validator)
            })
            // filter out any validator with the zero address
            .filter(|x| !H256::is_zero(x))
            .collect_vec();
        Ok((validators, multisig_ism.threshold))
    }
}

#[async_trait]
impl RoutingIsm for AleoIsm {
    /// Returns the ISM needed to verify message
    async fn route(&self, message: &HyperlaneMessage) -> ChainResult<H256> {
        let key = RouteKey {
            ism: self.aleo_address,
            domain: message.origin,
        };
        let routed_ism: Address<CurrentNetwork> = self
            .provider
            .get_mapping_value(&self.program, "routes", &key)
            .await?;
        Ok(to_h256(routed_ism)?)
    }
}
