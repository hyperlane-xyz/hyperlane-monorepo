use std::str::FromStr;

use async_trait::async_trait;

use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneMessage, HyperlaneProvider, RawHyperlaneMessage, RoutingIsm, H256,
};

use crate::{CosmosAddress, CosmosProvider};

use super::payloads::ism_routes::{
    IsmRouteRequest, IsmRouteRequestInner, IsmRouteRespnose, QueryRoutingIsmGeneralRequest,
};
use super::CwQueryClient;

/// A reference to a RoutingIsm contract on some Cosmos chain
#[derive(Debug)]
pub struct CwRoutingIsm {
    domain: HyperlaneDomain,
    address: H256,
    provider: CosmosProvider<CwQueryClient>,
}

impl CwRoutingIsm {
    /// create a new instance of CosmosRoutingIsm
    pub fn new(
        provider: CosmosProvider<CwQueryClient>,
        locator: ContractLocator,
    ) -> ChainResult<Self> {
        Ok(Self {
            domain: locator.domain.clone(),
            address: locator.address,
            provider,
        })
    }
}

impl HyperlaneContract for CwRoutingIsm {
    fn address(&self) -> H256 {
        self.address
    }
}

impl HyperlaneChain for CwRoutingIsm {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

#[async_trait]
impl RoutingIsm for CwRoutingIsm {
    async fn route(&self, message: &HyperlaneMessage) -> ChainResult<H256> {
        let payload = IsmRouteRequest {
            route: IsmRouteRequestInner {
                message: hex::encode(RawHyperlaneMessage::from(message)),
            },
        };

        let data = self
            .provider
            .query()
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
