use std::fmt::Debug;
use std::time::Duration;

use async_trait::async_trait;
use auto_impl::auto_impl;

use crate::ChainResult;

/// Handles the logic of what the next block range that should be
/// queried when syncing dispatched messages.
#[async_trait]
#[auto_impl(Box)]
pub trait MessageSyncCursor: Debug + Send + Sync + 'static {
    /// The next block range that should be queried, or None if no range should
    /// be queried.
    async fn next_range(&mut self) -> ChainResult<Option<(u32, u32, Duration)>>;
    /// The next message nonce that the cursor is expecting.
    fn next_nonce(&self) -> u32;
    /// Rewinds the cursor to an earlier block if the message with the next
    /// nonce appears to have been dropped.
    async fn rewind(&mut self) -> ChainResult<u32>;
    /// Fast forwards the cursor to the next message nonce and block.
    async fn fast_forward(&mut self) -> bool;
}

// TODO: Can we delete some of these methods?
/// Tool for handling the logic of what the next block range that should be
/// queried and may perform rate limiting on `next_range` queries.
#[async_trait]
#[auto_impl(Box)]
pub trait SyncBlockRangeCursor: Send + 'static {
    /// Returns the current `from` position of the indexer. Note that
    /// `next_range` may return a `from` value that is lower than this in order
    /// to have some overlap.
    fn current_position(&self) -> u32;

    /// Returns the current `tip` of the blockchain. This is the highest block
    /// we know of.
    fn tip(&self) -> u32;

    /// Returns the current distance from the tip of the blockchain.
    fn distance_from_tip(&self) -> u32 {
        self.tip().saturating_sub(self.current_position())
    }

    /// Get the next block range `(from, to)` which should be fetched (this
    /// returns an inclusive range such as (0,50), (51,100), ...). This
    /// will automatically rate limit based on how far we are from the
    /// highest block we can scrape according to
    /// `get_finalized_block_number`.
    ///
    /// In reality this will often return a from value that overlaps with the
    /// previous range to help ensure that we scrape everything even if the
    /// provider failed to respond in full previously.
    ///
    /// This assumes the caller will call next_range again automatically on Err,
    /// but it returns the error to allow for tailored logging or different end
    /// cases.
    async fn next_range(&mut self) -> ChainResult<Option<(u32, u32, Duration)>>;

    /// If there was an issue when a range of data was fetched, this rolls back
    /// so the next range fetched will be from `start_from`. Note that it is a
    /// no-op if a later block value is specified.
    fn backtrack(&mut self, from_block: u32) -> ChainResult<u32>;
}
