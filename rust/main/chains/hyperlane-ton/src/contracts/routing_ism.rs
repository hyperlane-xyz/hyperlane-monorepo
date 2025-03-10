use async_trait::async_trait;
use tonlib_core::TonAddress;

use hyperlane_core::{
    ChainResult, HyperlaneChain, HyperlaneContract, HyperlaneDomain, HyperlaneMessage,
    HyperlaneProvider, RoutingIsm, H256,
};

use crate::{client::provider::TonProvider, utils::conversion::ConversionUtils};

#[derive(Debug)]
/// A reference to a RoutingIsm contract on some TON chain
pub struct TonRoutingIsm {
    provider: TonProvider,
    address: TonAddress,
}

impl TonRoutingIsm {
    /// Create a new instance of TonRoutingIsm
    pub fn new(provider: TonProvider, address: TonAddress) -> ChainResult<Self> {
        Ok(Self { provider, address })
    }
}

impl HyperlaneContract for TonRoutingIsm {
    fn address(&self) -> H256 {
        ConversionUtils::ton_address_to_h256(&self.address)
    }
}

impl HyperlaneChain for TonRoutingIsm {
    fn domain(&self) -> &HyperlaneDomain {
        &self.provider.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        unimplemented!("TON provider is not implemented yet.")
    }
}

#[async_trait]
impl RoutingIsm for TonRoutingIsm {
    /// Determine the route for the given message
    async fn route(&self, _message: &HyperlaneMessage) -> ChainResult<H256> {
        unimplemented!("TON RoutingIsm::route is not implemented yet.")
    }
}
