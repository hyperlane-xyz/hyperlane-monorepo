use async_trait::async_trait;

use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneMessage, HyperlaneProvider, RawHyperlaneMessage, RoutingIsm, H256,
};

use crate::{
    grpc::{WasmGrpcProvider, WasmProvider},
    payloads::ism_routes::{IsmRouteRequest, IsmRouteRequestInner, IsmRouteRespnose},
    signers::Signer,
    verify::bech32_decode,
    ConnectionConf,
};

/// A reference to a RoutingIsm contract on some Cosmos chain
#[derive(Debug)]
pub struct CosmosRoutingIsm<'a> {
    conf: &'a ConnectionConf,
    locator: &'a ContractLocator<'a>,
    signer: &'a Signer,
    provider: Box<WasmGrpcProvider<'a>>,
}

impl<'a> CosmosRoutingIsm<'a> {
    /// create a new instance of CosmosRoutingIsm
    pub fn new(conf: &'a ConnectionConf, locator: &'a ContractLocator, signer: &'a Signer) -> Self {
        let provider = WasmGrpcProvider::new(conf, locator, signer);

        Self {
            conf,
            locator,
            signer,
            provider: Box::new(provider),
        }
    }
}

impl HyperlaneContract for CosmosRoutingIsm<'_> {
    fn address(&self) -> H256 {
        self.locator.address
    }
}

impl HyperlaneChain for CosmosRoutingIsm<'_> {
    fn domain(&self) -> &HyperlaneDomain {
        &self.locator.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        todo!()
    }
}

#[async_trait]
impl RoutingIsm for CosmosRoutingIsm<'_> {
    async fn route(&self, message: &HyperlaneMessage) -> ChainResult<H256> {
        let payload = IsmRouteRequest {
            route: IsmRouteRequestInner {
                message: hex::encode(RawHyperlaneMessage::from(message)),
            },
        };

        let data = self.provider.wasm_query(payload, None).await?;
        let response: IsmRouteRespnose = serde_json::from_slice(&data)?;

        Ok(bech32_decode(response.ism))
    }
}
