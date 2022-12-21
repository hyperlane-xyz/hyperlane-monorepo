use async_trait::async_trait;

use hyperlane_core::{
    accumulator::merkle::Proof, ChainResult, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    MultisigIsm, MultisigSignedCheckpoint, H160, H256,
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
}

#[async_trait]
impl MultisigIsm for FuelMultisigIsm {
    async fn format_metadata(
        &self,
        checkpoint: &MultisigSignedCheckpoint,
        proof: Proof,
    ) -> ChainResult<Vec<u8>> {
        todo!()
    }

    async fn threshold(&self, domain: u32) -> ChainResult<u8> {
        todo!()
    }

    async fn validators(&self, domain: u32) -> ChainResult<Vec<H160>> {
        todo!()
    }
}
