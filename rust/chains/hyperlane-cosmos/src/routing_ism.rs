use async_trait::async_trait;

use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneMessage, HyperlaneProvider, RawHyperlaneMessage, RoutingIsm, H256,
};

use crate::{
    grpc::{WasmGrpcProvider, WasmProvider},
    payloads::ism_routes::{
        IsmRouteRequest, IsmRouteRequestInner, IsmRouteRespnose, QueryRoutingIsmGeneralRequest,
    },
    signers::Signer,
    verify::bech32_decode,
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
    pub fn new(conf: &ConnectionConf, locator: ContractLocator, signer: Signer) -> Self {
        let provider = WasmGrpcProvider::new(conf.clone(), locator.clone(), signer.clone());

        Self {
            domain: locator.domain.clone(),
            address: locator.address,
            provider: Box::new(provider),
        }
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
        let payload = IsmRouteRequest {
            route: IsmRouteRequestInner {
                message: hex::encode(RawHyperlaneMessage::from(message)),
            },
        };

        let data = self
            .provider
            .wasm_query(
                QueryRoutingIsmGeneralRequest {
                    routing_ism: payload,
                },
                None,
            )
            .await?;
        let response: IsmRouteRespnose = serde_json::from_slice(&data)?;

        Ok(bech32_decode(response.ism))
    }
}
