use std::fmt::Debug;

use async_trait::async_trait;
use auto_impl::auto_impl;

use crate::{
    accumulator::incremental::IncrementalMerkle, ChainResult, Checkpoint, HyperlaneContract,
    ReorgPeriod,
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
    async fn tree(&self, lag: Option<&ReorgPeriod>) -> ChainResult<IncrementalMerkle>;

    /// Gets the current leaf count of the merkle tree
    ///
    /// - `lag` is how far behind the current block to query, if not specified
    ///   it will query at the latest block.
    async fn count(&self, lag: Option<&ReorgPeriod>) -> ChainResult<u32>;

    /// Get the latest checkpoint.
    ///
    /// - `lag` is how far behind the current block to query, if not specified
    ///   it will query at the latest block.
    async fn latest_checkpoint(&self, lag: Option<&ReorgPeriod>) -> ChainResult<Checkpoint>;
}
