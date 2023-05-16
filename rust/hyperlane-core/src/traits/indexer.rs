//! An Indexer provides a common interface for bubbling up chain-specific
//! event-data to another entity (e.g. a `ContractSync`). For example, the only
//! way to retrieve data such as the chain's latest block number or a list of
//! checkpoints/messages emitted within a certain block range by calling out to
//! a chain-specific library and provider (e.g. ethers::provider).

use std::fmt::Debug;

use async_trait::async_trait;
use auto_impl::auto_impl;

use crate::{ChainResult, HyperlaneMessage, LogMeta};

/// Interface for an indexer.
#[async_trait]
#[auto_impl(&, Box, Arc,)]
pub trait Indexer<T: Sized>: Send + Sync + Debug {
    /// Fetch list of logs between blocks `from` and `to`, inclusive.
    async fn fetch_logs(&self, from: u32, to: u32) -> ChainResult<Vec<(T, LogMeta)>>;

    /// Get the chain's latest block number that has reached finality
    async fn get_finalized_block_number(&self) -> ChainResult<u32>;
}

/// Interface for Mailbox contract indexer. Interface for allowing other
/// entities to retrieve chain-specific data from a mailbox.
#[async_trait]
#[auto_impl(&, Box, Arc)]
pub trait MessageIndexer: Indexer<HyperlaneMessage> + 'static {
    /// Return the latest finalized mailbox count and block number
    async fn fetch_count_at_tip(&self) -> ChainResult<(u32, u32)>;
}
