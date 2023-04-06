use async_trait::async_trait;

use hyperlane_core::{
    ChainResult, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneMessage, HyperlaneProvider, MultisigIsm, H256,
};

/// A reference to a MultisigIsm contract on some Fuel chain
#[derive(Debug)]
pub struct FuelMultisigIsm {}

impl HyperlaneContract for FuelMultisigIsm {
    fn address(&self) -> H256 {
        todo!()
    }
}

impl HyperlaneChain for FuelMultisigIsm {
    fn domain(&self) -> &HyperlaneDomain {
        todo!()
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        todo!()
    }
}

#[async_trait]
impl MultisigIsm for FuelMultisigIsm {
    /// Returns the validator and threshold needed to verify message
    async fn validators_and_threshold(
        &self,
        message: &HyperlaneMessage,
    ) -> ChainResult<(Vec<H256>, u8)> {
        todo!()
    }
}
