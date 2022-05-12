//! An Indexer provides a common interface for bubbling up chain-specific
//! event-data to another entity (e.g. a `ContractSync`). For example, the only
//! way to retrieve data such as the chain's latest block number or a list of
//! checkpoints/messages emitted within a certain block range by calling out to a
//! chain-specific library and provider (e.g. ethers::provider). A
//! chain-specific outbox or inbox should implement one or both of the Indexer
//! traits (CommonIndexer or OutboxIndexer) to provide an common interface which
//! other entities can retrieve this chain-specific info.

use async_trait::async_trait;
use eyre::Result;

use crate::{CheckpointWithMeta, RawCommittedMessage};

/// Interface for Abacus Common contract indexer. Interface that allows for other
/// entities to retrieve chain-specific data from an outbox or inbox.
#[async_trait]
pub trait AbacusCommonIndexer: Send + Sync + std::fmt::Debug {
    /// Get chain's latest block number
    async fn get_block_number(&self) -> Result<u32>;

    /// Fetch sequentially sorted list of checkpoints between blocks `from` and `to`
    async fn fetch_sorted_checkpoints(&self, from: u32, to: u32)
        -> Result<Vec<CheckpointWithMeta>>;
}

/// Interface for Outbox contract indexer. Interface for allowing other
/// entities to retrieve chain-specific data from an outbox.
#[async_trait]
pub trait OutboxIndexer: AbacusCommonIndexer + Send + Sync + std::fmt::Debug {
    /// Fetch list of messages between blocks `from` and `to`.
    async fn fetch_sorted_messages(&self, _from: u32, _to: u32)
        -> Result<Vec<RawCommittedMessage>>;
}
