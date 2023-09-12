use async_trait::async_trait;
use hyperlane_core::{
    ChainResult, ContractLocator, Encode, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneMessage, HyperlaneProvider, InterchainSecurityModule, ModuleType, H256, U256,
};

use crate::{
    grpc::{WasmGrpcProvider, WasmProvider},
    ConnectionConf, CosmosProvider, Signer,
};

#[derive(Debug)]
pub struct CosmosInterchainSecurityModule {
    domain: HyperlaneDomain,
    address: H256,
    provider: Box<WasmGrpcProvider>,
}

impl CosmosInterchainSecurityModule {
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
        hpl_interface::ism::ISMType::Multisig => ModuleType::MessageIdMultisig,
        hpl_interface::ism::ISMType::Owned => ModuleType::MessageIdMultisig,
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

        // FIXME: consistency
        let resp_a = serde_json::from_slice::<hpl_interface::ism::ISMType>(&data);
        let resp_b = serde_json::from_slice::<hpl_interface::ism::ModuleTypeResponse>(&data);

        Ok(match (resp_a, resp_b) {
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
