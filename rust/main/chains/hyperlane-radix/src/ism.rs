use async_trait::async_trait;
use scrypto::types::ComponentAddress;

use hyperlane_core::{
    ChainResult, ContractLocator, Encode, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneMessage, HyperlaneProvider, InterchainSecurityModule, Metadata, ModuleType,
    MultisigIsm, RoutingIsm, H160, H256, U256,
};

use crate::{
    address_to_h256, encode_component_address, ConnectionConf, EthAddress, IsmTypes, RadixProvider,
};

/// Radix ISM
#[derive(Debug)]
pub struct RadixIsm {
    provider: RadixProvider,
    encoded_address: String,
    address_256: H256,
}

impl RadixIsm {
    /// New ISM instance
    pub fn new(
        provider: RadixProvider,
        locator: &ContractLocator,
        conf: &ConnectionConf,
    ) -> ChainResult<Self> {
        let encoded_address = encode_component_address(&conf.network, locator.address)?;
        Ok(Self {
            encoded_address,
            provider,
            address_256: locator.address,
        })
    }
}

impl HyperlaneContract for RadixIsm {
    fn address(&self) -> H256 {
        self.address_256
    }
}

impl HyperlaneChain for RadixIsm {
    fn domain(&self) -> &HyperlaneDomain {
        self.provider.domain()
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

#[async_trait]
impl InterchainSecurityModule for RadixIsm {
    /// Returns the module type of the ISM compliant with the corresponding
    /// metadata offchain fetching and onchain formatting standard.
    async fn module_type(&self) -> ChainResult<ModuleType> {
        let (types, _) = self
            .provider
            .call_method::<IsmTypes>(&self.encoded_address, "module_type", None, Vec::new())
            .await?;

        let result = match types {
            IsmTypes::Unused => ModuleType::Unused,
            IsmTypes::Routing => ModuleType::Routing,
            IsmTypes::Aggregation => ModuleType::Aggregation,
            IsmTypes::LegacyMultisig => ModuleType::LegacyMultisig,
            IsmTypes::MerkleRootMultisig => ModuleType::MerkleRootMultisig,
            IsmTypes::MessageIdMultisig => ModuleType::MessageIdMultisig,
            IsmTypes::Null => ModuleType::Null,
            IsmTypes::CcipRead => ModuleType::CcipRead,
        };
        Ok(result)
    }

    /// Dry runs the `verify()` ISM call and returns `Some(gas_estimate)` if the call
    /// succeeds.
    async fn dry_run_verify(
        &self,
        _message: &HyperlaneMessage,
        _metadata: &Metadata,
    ) -> ChainResult<Option<U256>> {
        Ok(Some(U256::one())) // NOTE: we don't need to implement this, as there is no aggregation ism and we can't save any costs
    }
}

#[async_trait]
impl MultisigIsm for RadixIsm {
    /// Returns the validator and threshold needed to verify message
    async fn validators_and_threshold(
        &self,
        message: &HyperlaneMessage,
    ) -> ChainResult<(Vec<H256>, u8)> {
        let message = message.to_vec();

        let (validators, threshold): (Vec<EthAddress>, usize) = self
            .provider
            .call_method_with_arg(&self.encoded_address, "validators_and_threshold", &message)
            .await?;

        Ok((
            validators
                .into_iter()
                .map(|x| Into::<H160>::into(x).into()) // convert EthAddress -> H160 -> H256
                .collect(),
            threshold as u8,
        ))
    }
}

#[async_trait]
impl RoutingIsm for RadixIsm {
    /// Returns the ISM needed to verify message
    async fn route(&self, message: &HyperlaneMessage) -> ChainResult<H256> {
        let message = message.to_vec();
        let route: ComponentAddress = self
            .provider
            .call_method_with_arg(&self.encoded_address, "route", &message)
            .await?;

        Ok(address_to_h256(route))
    }
}
