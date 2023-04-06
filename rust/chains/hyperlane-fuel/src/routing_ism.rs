use async_trait::async_trait;

use hyperlane_core::{
    ChainResult, HyperlaneChain, HyperlaneContract, HyperlaneDomain, HyperlaneMessage,
    HyperlaneProvider, RoutingIsm, H256,
};

/// A reference to a RoutingIsm contract on some Fuel chain
#[derive(Debug)]
pub struct FuelRoutingIsm {}

impl HyperlaneContract for FuelRoutingIsm {
    fn address(&self) -> H256 {
        todo!()
    }
}

impl HyperlaneChain for FuelRoutingIsm {
    fn domain(&self) -> &HyperlaneDomain {
        todo!()
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        todo!()
    }
}

#[async_trait]
impl RoutingIsm for FuelRoutingIsm {
    /// Returns the ism needed to verify message
    async fn route(&self, message: &HyperlaneMessage) -> ChainResult<H256> {
        todo!()
    }
}
