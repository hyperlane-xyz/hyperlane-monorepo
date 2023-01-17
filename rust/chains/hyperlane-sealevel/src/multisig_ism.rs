use async_trait::async_trait;

use hyperlane_core::{
    accumulator::merkle::Proof, ChainResult, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneMessage, MultisigIsm, MultisigSignedCheckpoint, H256,
};

/// A reference to a MultisigIsm contract on some Sealevel chain
#[derive(Debug)]
pub struct SealevelMultisigIsm {}

impl HyperlaneContract for SealevelMultisigIsm {
    fn address(&self) -> H256 {
        todo!()
    }
}

impl HyperlaneChain for SealevelMultisigIsm {
    fn domain(&self) -> &HyperlaneDomain {
        todo!()
    }
}

#[async_trait]
impl MultisigIsm for SealevelMultisigIsm {
    /// Returns the validator and threshold needed to verify message
    async fn validators_and_threshold(
        &self,
        message: &HyperlaneMessage,
    ) -> ChainResult<(Vec<H256>, u8)> {
        todo!()
    }

    /// Returns the metadata needed by the contract's verify function
    fn format_metadata(
        &self,
        validators: &[H256],
        threshold: u8,
        checkpoint: &MultisigSignedCheckpoint,
        proof: &Proof,
    ) -> Vec<u8> {
        todo!()
    }
}
