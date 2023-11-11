use async_trait::async_trait;
use hpl_interface::ism::IsmQueryMsg;
use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneMessage, HyperlaneProvider, InterchainSecurityModule, ModuleType, H256, U256,
};

use crate::{
    grpc::{WasmGrpcProvider, WasmProvider},
    types::IsmType,
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
    pub fn new(
        conf: &ConnectionConf,
        locator: ContractLocator,
        signer: Option<Signer>,
    ) -> ChainResult<Self> {
        let provider: WasmGrpcProvider =
            WasmGrpcProvider::new(conf.clone(), locator.clone(), signer)?;

        Ok(Self {
            domain: locator.domain.clone(),
            address: locator.address,
            provider: Box::new(provider),
        })
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

#[async_trait]
impl InterchainSecurityModule for CosmosInterchainSecurityModule {
    /// Returns the module type of the ISM compliant with the corresponding
    /// metadata offchain fetching and onchain formatting standard.
    async fn module_type(&self) -> ChainResult<ModuleType> {
        let query = IsmQueryMsg::ModuleType {};

        let data = self.provider.wasm_query(query.wrap(), None).await?;

        let module_type_response =
            serde_json::from_slice::<hpl_interface::ism::ModuleTypeResponse>(&data)?;
        Ok(IsmType(module_type_response.typ).into())
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
