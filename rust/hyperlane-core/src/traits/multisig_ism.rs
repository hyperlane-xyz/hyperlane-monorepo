use std::fmt::Debug;

use async_trait::async_trait;
use auto_impl::auto_impl;

use crate::{
    accumulator::merkle::Proof, ChainResult, HyperlaneContract, HyperlaneMessage,
    MultisigSignedCheckpoint,
};

/// Interface for the MultisigIsm chain contract. Allows abstraction over
/// different chains
#[async_trait]
#[auto_impl(Box, Arc)]
pub trait MultisigIsm: HyperlaneContract + Send + Sync + Debug {
    /// Returns the metadata needed by the contract's verify function
    async fn format_metadata(
        &self,
        message: &HyperlaneMessage,
        checkpoint: &MultisigSignedCheckpoint,
        proof: &Proof,
    ) -> ChainResult<Vec<u8>>;
}
