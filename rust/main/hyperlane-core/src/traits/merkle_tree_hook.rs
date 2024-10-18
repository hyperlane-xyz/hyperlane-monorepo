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
    /// - `reorg_period` is how far behind the current block to query, if not specified
    ///   it will query at the latest block.
    async fn tree(&self, reorg_period: &ReorgPeriod) -> ChainResult<IncrementalMerkle>;

    /// Gets the current leaf count of the merkle tree
    ///
    /// - `reorg_period` is how far behind the current block to query, if not specified
    ///   it will query at the latest block.
    async fn count(&self, reorg_period: &ReorgPeriod) -> ChainResult<u32>;

    /// Get the latest checkpoint.
    ///
    /// - `reorg_period` is how far behind the current block to query, if not specified
    ///   it will query at the latest block.
    async fn latest_checkpoint(&self, reorg_period: &ReorgPeriod) -> ChainResult<Checkpoint>;
}
