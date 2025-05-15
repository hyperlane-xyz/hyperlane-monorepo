use std::fmt::Debug;

use async_trait::async_trait;
use auto_impl::auto_impl;
use derive_more::Deref;

use crate::{ChainResult, Checkpoint, HyperlaneContract, ReorgPeriod};

/// A wrapper around the IncrementalMerkle tree and the block height at which it was requested.
#[derive(Clone, Debug, Deref)]
pub struct IncrementalMerkleAtBlockHeight {
    /// The IncrementalMerkle tree
    #[deref]
    pub tree: crate::accumulator::incremental::IncrementalMerkle,
    /// The block height at which the tree was requested
    pub block_height: Option<u64>,
}

/// A wrapper around the Checkpoint and the block height at which it was requested.
#[derive(Clone, Debug, Deref)]
pub struct CheckpointAtBlockHeight {
    /// The Checkpoint
    #[deref]
    pub checkpoint: Checkpoint,
    /// The block height at which the checkpoint was requested
    pub block_height: Option<u64>,
}
/// Interface for the MerkleTreeHook chain contract. Allows abstraction over different
/// chains
#[async_trait]
#[auto_impl(&, Box, Arc)]
pub trait MerkleTreeHook: HyperlaneContract + Send + Sync + Debug {
    /// Return the incremental merkle tree in storage
    ///
    /// - `reorg_period` is how far behind the current block to query, if not specified
    ///   it will query at the latest block.
    async fn tree(&self, reorg_period: &ReorgPeriod)
        -> ChainResult<IncrementalMerkleAtBlockHeight>;

    /// Gets the current leaf count of the merkle tree
    ///
    /// - `reorg_period` is how far behind the current block to query, if not specified
    ///   it will query at the latest block.
    async fn count(&self, reorg_period: &ReorgPeriod) -> ChainResult<u32>;

    /// Get the latest checkpoint.
    ///
    /// - `reorg_period` is how far behind the current block to query, if not specified
    ///   it will query at the latest block.
    async fn latest_checkpoint(
        &self,
        reorg_period: &ReorgPeriod,
    ) -> ChainResult<CheckpointAtBlockHeight>;

    /// Get the latest checkpoint at a specific block height.
    async fn latest_checkpoint_at_height(
        &self,
        height: u64,
    ) -> ChainResult<CheckpointAtBlockHeight>;
}
