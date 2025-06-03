use async_trait::async_trait;
use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneMessage, HyperlaneProvider, InterchainSecurityModule, ModuleType, RawHyperlaneMessage,
    H256, U256,
};

use crate::{
    grpc::WasmProvider,
    payloads::{
        aggregate_ism::{VerifyRequest, VerifyRequestInner, VerifyResponse},
        general::EmptyStruct,
        ism_routes::{QueryIsmGeneralRequest, QueryIsmModuleTypeRequest},
    },
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
    provider: CosmosProvider,
}

/// The Cosmos Interchain Security Module Implementation.
impl CosmosInterchainSecurityModule {
    /// Creates a new Cosmos Interchain Security Module.
    pub fn new(provider: CosmosProvider, locator: ContractLocator) -> ChainResult<Self> {
        Ok(Self {
            domain: locator.domain.clone(),
            address: locator.address,
            provider,
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
        Box::new(self.provider.clone())
    }
}

#[async_trait]
impl InterchainSecurityModule for CosmosInterchainSecurityModule {
    /// Returns the module type of the ISM compliant with the corresponding
    /// metadata offchain fetching and onchain formatting standard.
    async fn module_type(&self) -> ChainResult<ModuleType> {
        let query = QueryIsmModuleTypeRequest {
            module_type: EmptyStruct {},
        };

        let data = self
            .provider
            .grpc()
            .wasm_query(QueryIsmGeneralRequest { ism: query }, None)
            .await?;

        let module_type_response =
            serde_json::from_slice::<hyperlane_cosmwasm_interface::ism::ModuleTypeResponse>(&data)?;
        Ok(IsmType(module_type_response.typ).into())
    }

    /// Dry runs the `verify()` ISM call and returns `Some(gas_estimate)` if the call
    /// succeeds.
    async fn dry_run_verify(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
    ) -> ChainResult<Option<U256>> {
        let payload = VerifyRequest {
            verify: VerifyRequestInner {
                metadata: hex::encode(metadata),
                message: hex::encode(RawHyperlaneMessage::from(message)),
            },
        };
        let data = self
            .provider
            .grpc()
            .wasm_query(QueryIsmGeneralRequest { ism: payload }, None)
            .await?;
        let response: VerifyResponse = serde_json::from_slice(&data)?;
        // We can't simulate the `verify` call in CosmWasm because
        // it's not marked as an entrypoint. So we just use the query interface
        // and hardcode a gas value - this can be inefficient if one ISM is
        // vastly cheaper than another one.
        let dummy_gas_value = U256::one();
        Ok(response.verified.then_some(dummy_gas_value))
    }
}
