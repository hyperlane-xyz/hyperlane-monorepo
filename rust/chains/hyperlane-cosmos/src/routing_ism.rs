use async_trait::async_trait;

use hyperlane_core::{
    ChainResult, HyperlaneChain, HyperlaneContract, HyperlaneDomain, HyperlaneMessage,
    HyperlaneProvider, RoutingIsm, H256,
};

/// A reference to a RoutingIsm contract on some Cosmos chain
#[derive(Debug)]
pub struct CosmosRoutingIsm {}

impl HyperlaneContract for CosmosRoutingIsm {
    fn address(&self) -> H256 {
        todo!()
    }
}

impl HyperlaneChain for CosmosRoutingIsm {
    fn domain(&self) -> &HyperlaneDomain {
        todo!()
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        todo!()
    }
}

#[async_trait]
impl RoutingIsm for CosmosRoutingIsm {
    async fn route(&self, message: &HyperlaneMessage) -> ChainResult<H256> {
        todo!()
    }
}
