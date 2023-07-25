use async_trait::async_trait;

use cosmrs::crypto::secp256k1::SigningKey;
use hyperlane_core::{
    ChainResult, HyperlaneChain, HyperlaneContract, HyperlaneDomain, HyperlaneMessage,
    HyperlaneProvider, RawHyperlaneMessage, RoutingIsm, H256,
};

use crate::{
    grpc::{WasmGrpcProvider, WasmProvider},
    payloads::ism_routes::{IsmRouteRequest, IsmRouteRequestInner, IsmRouteRespnose},
    verify::{self, bech32_decode},
};

/// A reference to a RoutingIsm contract on some Cosmos chain
#[derive(Debug)]
pub struct CosmosRoutingIsm {
    domain: HyperlaneDomain,
    address: String,
    provider: Box<WasmGrpcProvider>,
}

impl CosmosRoutingIsm {
    /// create a new instance of CosmosRoutingIsm
    pub fn new(
        domain: HyperlaneDomain,
        address: String,
        prefix: String,
        private_key: Vec<u8>,
        grpc_endpoint: String,
        chain_id: String,
    ) -> Self {
        let signer_address = verify::pub_to_addr(
            SigningKey::from_slice(&private_key)
                .unwrap()
                .public_key()
                .to_bytes(),
            &prefix,
        )
        .unwrap();

        let provider = WasmGrpcProvider::new(
            address.clone(),
            private_key,
            signer_address,
            prefix,
            grpc_endpoint,
            chain_id,
        );

        Self {
            domain,
            address,
            provider: Box::new(provider),
        }
    }
}

impl HyperlaneContract for CosmosRoutingIsm {
    fn address(&self) -> H256 {
        bech32_decode(self.address.clone())
    }
}

impl HyperlaneChain for CosmosRoutingIsm {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        todo!()
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

        let data = self.provider.wasm_query(payload, None).await?;
        let response: IsmRouteRespnose = serde_json::from_slice(&data)?;

        Ok(bech32_decode(response.ism))
    }
}
