use async_trait::async_trait;
use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneMessage, HyperlaneProvider, InterchainSecurityModule, ModuleType, H256, U256,
};

use crate::{
    grpc::{WasmGrpcProvider, WasmProvider},
    ConnectionConf, CosmosProvider, Signer,
};

#[derive(Debug)]
/// The Cosmos Interchain Security Module.
pub struct CosmosInterchainSecurityModule {
    /// The domain of the ISM contract.
    domain: HyperlaneDomain,
    /// The address of the ISM contract.
    address: H256,
    /// The provider for the ISM contract.
    provider: Box<WasmGrpcProvider>,
}

/// The Cosmos Interchain Security Module Implementation.
impl CosmosInterchainSecurityModule {
    /// Creates a new Cosmos Interchain Security Module.
    pub fn new(conf: &ConnectionConf, locator: ContractLocator, signer: Signer) -> Self {
        let provider: WasmGrpcProvider =
            WasmGrpcProvider::new(conf.clone(), locator.clone(), signer.clone());

        Self {
            domain: locator.domain.clone(),
            address: locator.address,
            provider: Box::new(provider),
        }
    }
}

impl HyperlaneContract for CosmosInterchainSecurityModule {
    fn address(&self) -> H256 {
        self.address
    }
}

impl HyperlaneChain for CosmosInterchainSecurityModule {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(CosmosProvider::new(self.domain.clone()))
    }
}

fn ism_type_to_module_type(ism_type: hpl_interface::ism::ISMType) -> ModuleType {
    match ism_type {
        hpl_interface::ism::ISMType::Unused => ModuleType::Unused,
        hpl_interface::ism::ISMType::Routing => ModuleType::Routing,
        hpl_interface::ism::ISMType::Aggregation => ModuleType::Aggregation,
        hpl_interface::ism::ISMType::LegacyMultisig => ModuleType::MessageIdMultisig,
        hpl_interface::ism::ISMType::MerkleRootMultisig => ModuleType::MerkleRootMultisig,
        hpl_interface::ism::ISMType::MessageIdMultisig => ModuleType::MessageIdMultisig,
        hpl_interface::ism::ISMType::Null => ModuleType::Null,
        hpl_interface::ism::ISMType::CcipRead => ModuleType::CcipRead,
        _ => ModuleType::Null,
    }
}

#[async_trait]
impl InterchainSecurityModule for CosmosInterchainSecurityModule {
    /// Returns the module type of the ISM compliant with the corresponding
    /// metadata offchain fetching and onchain formatting standard.
    async fn module_type(&self) -> ChainResult<ModuleType> {
        let query = hpl_interface::ism::ISMQueryMsg::ModuleType {};

        let data = self.provider.wasm_query(query, None).await?;

        // Handle both the ISMType response and the ModuleTypeResponse response.
        let ismtype_response = serde_json::from_slice::<hpl_interface::ism::ISMType>(&data);
        let moduletye_response =
            serde_json::from_slice::<hpl_interface::ism::ModuleTypeResponse>(&data);

        Ok(match (ismtype_response, moduletye_response) {
            (Ok(v), _) => ism_type_to_module_type(v),
            (_, Ok(v)) => ism_type_to_module_type(v.typ),
            _ => ModuleType::Null,
        })
    }

    /// Dry runs the `verify()` ISM call and returns `Some(gas_estimate)` if the call
    /// succeeds.
    async fn dry_run_verify(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
    ) -> ChainResult<Option<U256>> {
        Ok(Some(U256::from(1000))) // TODO
    }
}
