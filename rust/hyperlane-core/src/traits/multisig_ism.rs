use std::fmt::Debug;

use async_trait::async_trait;
use auto_impl::auto_impl;

use crate::{
    accumulator::merkle::Proof, ChainResult, HyperlaneContract, MultisigSignedCheckpoint, H160,
};

/// Interface for the MultisigIsm chain contract. Allows abstraction over
/// different chains
#[async_trait]
#[auto_impl(&, Box, Arc)]
pub trait MultisigIsm: HyperlaneContract + Send + Sync + Debug {
    /// Returns the metadata needed by the contract's verify function
    async fn format_metadata(
        &self,
        checkpoint: &MultisigSignedCheckpoint,
        proof: Proof,
    ) -> ChainResult<Vec<u8>>;

    /// Fetch the threshold for the provided domain
    async fn threshold(&self, domain: u32) -> ChainResult<u8>;

    /// Fetch the validators for the provided domain
    async fn validators(&self, domain: u32) -> ChainResult<Vec<H160>>;
}
