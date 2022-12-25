use std::fmt::Debug;

use async_trait::async_trait;
use auto_impl::auto_impl;

use crate::{
    accumulator::merkle::Proof, ChainResult, HyperlaneContract, HyperlaneMessage,
    MultisigSignedCheckpoint, H256,
};

// TODO: Consider exposing `verify()`, it would let us tell the difference
// between reverting in the ISM vs in recipient.handle().
/// Interface for the MultisigIsm chain contract. Allows abstraction over
/// different chains
#[async_trait]
#[auto_impl(Box, Arc)]
pub trait MultisigIsm: HyperlaneContract + Send + Sync + Debug {
        /// Returns the validator and threshold needed to verify message
        async fn validators_and_threshold(
            &self,
            message: HyperlaneMessage,
        ) -> ChainResult<(Vec<H256>, u8)>;
    
        /// Returns the metadata needed by the contract's verify function
        fn format_metadata(
            &self,
            validators: Vec<H256>,
            threshold: u8,
            checkpoint: &MultisigSignedCheckpoint,
            proof: Proof,
        ) -> Vec<u8>;
}
