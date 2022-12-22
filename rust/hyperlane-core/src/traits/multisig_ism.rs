use std::fmt::Debug;

use async_trait::async_trait;
use auto_impl::auto_impl;

use crate::{
    accumulator::merkle::Proof, ChainResult, HyperlaneContract, HyperlaneMessage,
    MultisigSignedCheckpoint,
};

// TODO: Consider exposing `verify()`, it would let us tell the difference
// between reverting in the ISM vs in recipient.handle().
/// Interface for the MultisigIsm chain contract. Allows abstraction over
/// different chains
#[async_trait]
#[auto_impl(Box, Arc)]
pub trait MultisigIsm: HyperlaneContract + Send + Sync + Debug {
    /// Returns the metadata needed by the contract's verify function
    async fn format_metadata(
        &self,
        message: HyperlaneMessage,
        checkpoint: &MultisigSignedCheckpoint,
        proof: Proof,
    ) -> ChainResult<Vec<u8>>;
}
