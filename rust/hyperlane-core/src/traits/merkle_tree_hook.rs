use std::fmt::Debug;
use std::num::NonZeroU64;

use async_trait::async_trait;
use auto_impl::auto_impl;

use crate::{
    accumulator::incremental::IncrementalMerkle, ChainResult, Checkpoint, HyperlaneContract,
};

/// Interface for the MerkleTreeHook chain contract. Allows abstraction over different
/// chains
#[async_trait]
#[auto_impl(&, Box, Arc)]
pub trait MerkleTreeHook: HyperlaneContract + Send + Sync + Debug {
    /// Return the incremental merkle tree in storage
    ///
    /// - `lag` is how far behind the current block to query, if not specified
    ///   it will query at the latest block.
    async fn tree(&self, lag: Option<NonZeroU64>) -> ChainResult<IncrementalMerkle>;

    /// Gets the current leaf count of the merkle tree
    ///
    /// - `lag` is how far behind the current block to query, if not specified
    ///   it will query at the latest block.
    async fn count(&self, lag: Option<NonZeroU64>) -> ChainResult<u32>;

    /// Get the latest checkpoint.
    ///
    /// - `lag` is how far behind the current block to query, if not specified
    ///   it will query at the latest block.
    async fn latest_checkpoint(&self, lag: Option<NonZeroU64>) -> ChainResult<Checkpoint>;
}
