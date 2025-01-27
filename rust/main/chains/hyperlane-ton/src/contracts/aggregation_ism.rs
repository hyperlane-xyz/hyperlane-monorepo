use async_trait::async_trait;
use tonlib_core::TonAddress;

use hyperlane_core::{
    AggregationIsm, ChainResult, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneMessage, HyperlaneProvider, H256,
};

use crate::{client::provider::TonProvider, utils::conversion::ConversionUtils};

#[derive(Debug)]
pub struct TonAggregationIsm {
    provider: TonProvider,
    address: TonAddress,
}

impl TonAggregationIsm {
    pub fn new(provider: TonProvider, address: TonAddress) -> ChainResult<Self> {
        Ok(Self { provider, address })
    }
}

impl HyperlaneContract for TonAggregationIsm {
    fn address(&self) -> H256 {
        ConversionUtils::ton_address_to_h256(&self.address)
    }
}

impl HyperlaneChain for TonAggregationIsm {
    fn domain(&self) -> &HyperlaneDomain {
        &self.provider.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

#[async_trait]
impl AggregationIsm for TonAggregationIsm {
    async fn modules_and_threshold(
        &self,
        _message: &HyperlaneMessage,
    ) -> ChainResult<(Vec<H256>, u8)> {
        unimplemented!("TON AggregationIsm::modules_and_threshold is not implemented yet.")
    }
}
