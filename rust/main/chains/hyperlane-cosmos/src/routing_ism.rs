use std::str::FromStr;

use async_trait::async_trait;

use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneMessage, HyperlaneProvider, RawHyperlaneMessage, RoutingIsm, H256,
};

use crate::{
    grpc::WasmProvider,
    payloads::ism_routes::{
        IsmRouteRequest, IsmRouteRequestInner, IsmRouteRespnose, QueryRoutingIsmGeneralRequest,
    },
    signers::Signer,
    ConnectionConf, CosmosAddress, CosmosProvider,
};

/// A reference to a RoutingIsm contract on some Cosmos chain
#[derive(Debug)]
pub struct CosmosRoutingIsm {
    domain: HyperlaneDomain,
    address: H256,
    provider: CosmosProvider,
}

impl CosmosRoutingIsm {
    /// create a new instance of CosmosRoutingIsm
    pub fn new(provider: CosmosProvider, locator: ContractLocator) -> ChainResult<Self> {
        Ok(Self {
            domain: locator.domain.clone(),
            address: locator.address,
            provider,
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
        Box::new(self.provider.clone())
    }
}

#[async_trait]
impl RoutingIsm for CosmosRoutingIsm {
    async fn route(&self, message: &HyperlaneMessage) -> ChainResult<H256> {
        let payload = IsmRouteRequest {
            route: IsmRouteRequestInner {
                message: hex::encode(RawHyperlaneMessage::from(message)),
            },
        };

        let data = self
            .provider
            .grpc()
            .wasm_query(
                QueryRoutingIsmGeneralRequest {
                    routing_ism: payload,
                },
                None,
            )
            .await?;
        let response: IsmRouteRespnose = serde_json::from_slice(&data)?;

        Ok(CosmosAddress::from_str(&response.ism)?.digest())
    }
}
