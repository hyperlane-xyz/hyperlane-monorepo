use std::str::FromStr;

use async_trait::async_trait;

use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneMessage, HyperlaneProvider, RoutingIsm, H256,
};

use crate::{
    address::CosmosAddress,
    grpc::{WasmGrpcProvider, WasmProvider},
    payloads::ism_routes::{IsmRouteRequest, IsmRouteRespnose, QueryRoutingIsmGeneralRequest},
    signers::Signer,
    ConnectionConf, CosmosProvider,
};

/// A reference to a RoutingIsm contract on some Cosmos chain
#[derive(Debug)]
pub struct CosmosRoutingIsm {
    domain: HyperlaneDomain,
    address: H256,
    provider: Box<WasmGrpcProvider>,
}

impl CosmosRoutingIsm {
    /// create a new instance of CosmosRoutingIsm
    pub fn new(
        conf: &ConnectionConf,
        locator: ContractLocator,
        signer: Option<Signer>,
    ) -> ChainResult<Self> {
        let provider = WasmGrpcProvider::new(conf.clone(), locator.clone(), signer)?;

        Ok(Self {
            domain: locator.domain.clone(),
            address: locator.address,
            provider: Box::new(provider),
        })
    }
}

impl HyperlaneContract for CosmosRoutingIsm {
    fn address(&self) -> H256 {
        self.address
    }
}

impl HyperlaneChain for CosmosRoutingIsm {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(CosmosProvider::new(self.domain.clone()))
    }
}

#[async_trait]
impl RoutingIsm for CosmosRoutingIsm {
    async fn route(&self, message: &HyperlaneMessage) -> ChainResult<H256> {
        let payload = IsmRouteRequest::new(message);

        let data = self
            .provider
            .wasm_query(QueryRoutingIsmGeneralRequest::new(payload), None)
            .await?;
        let response: IsmRouteRespnose = serde_json::from_slice(&data)?;

        Ok(CosmosAddress::from_str(&response.ism)?.digest())
    }
}
