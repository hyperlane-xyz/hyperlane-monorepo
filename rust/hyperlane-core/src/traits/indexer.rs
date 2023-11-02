//! An Indexer provides a common interface for bubbling up chain-specific
//! event-data to another entity (e.g. a `ContractSync`). For example, the only
//! way to retrieve data such as the chain's latest block number or a list of
//! checkpoints/messages emitted within a certain block range by calling out to
//! a chain-specific library and provider (e.g. ethers::provider).

use std::fmt::Debug;
use std::ops::RangeInclusive;

use async_trait::async_trait;
use auto_impl::auto_impl;
use serde::Deserialize;

use crate::{ChainResult, LogMeta};

/// Indexing mode.
#[derive(Copy, Debug, Default, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub enum IndexMode {
    /// Block based indexing.
    #[default]
    Block,
    /// Sequence based indexing.
    Sequence,
}

/// Interface for an indexer.
#[async_trait]
#[auto_impl(&, Box, Arc,)]
pub trait Indexer<T: Sized>: Send + Sync + Debug {
    /// Fetch list of logs between blocks `from` and `to`, inclusive.
    async fn fetch_logs(&self, range: RangeInclusive<u32>) -> ChainResult<Vec<(T, LogMeta)>>;

    /// Get the chain's latest block number that has reached finality
    async fn get_finalized_block_number(&self) -> ChainResult<u32>;
}

/// Interface for indexing data in sequence.
#[async_trait]
#[auto_impl(&, Box, Arc)]
pub trait SequenceIndexer<T>: Indexer<T> {
    /// Return the latest finalized sequence (if any) and block number
    async fn sequence_and_tip(&self) -> ChainResult<(Option<u32>, u32)>;
}
