use std::fmt::Debug;

use async_trait::async_trait;
use auto_impl::auto_impl;
use eyre::Result;

use crate::LogMeta;

/// Interface for a HyperlaneLogStore that ingests logs.
#[async_trait]
#[auto_impl(&, Box, Arc)]
pub trait HyperlaneLogStore<T>: Send + Sync + Debug {
    /// Store a list of logs and their associated metadata
    /// Returns the number of elements that were stored.
    async fn store_logs(&self, logs: &[(T, LogMeta)]) -> Result<u32>;
}

/// A sequence is a monotonically increasing number that is incremented every time a message ID is indexed.
/// E.g. for Mailbox indexing, this is equal to the message nonce, and for merkle tree hook indexing, this
/// is equal to the leaf index.
pub trait Sequenced: 'static + Send + Sync {
    /// The sequence of this sequenced type.
    fn sequence(&self) -> u32;
}

/// Extension of HyperlaneLogStore trait that supports indexed sequenced data.
#[async_trait]
#[auto_impl(&, Box, Arc)]
pub trait HyperlaneSequenceIndexerStore<T>: HyperlaneLogStore<T>
where
    T: Send + Sync,
{
    /// Gets data by its sequence.
    async fn retrieve_by_sequence(&self, sequence: u32) -> Result<Option<T>>;

    /// Gets the block number at which the log occurred.
    async fn retrieve_log_block_number(&self, nonce: u32) -> Result<Option<u64>>;
}

/// Extension of HyperlaneLogStore trait that supports a high watermark for the highest indexed block number.
#[async_trait]
#[auto_impl(&, Box, Arc)]
pub trait HyperlaneWatermarkedLogStore<T>: HyperlaneLogStore<T> {
    /// Gets the block number high watermark
    async fn retrieve_high_watermark(&self) -> Result<Option<u32>>;

    /// Stores the block number high watermark
    async fn store_high_watermark(&self, block_number: u32) -> Result<()>;
}
