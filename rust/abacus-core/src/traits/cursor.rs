use async_trait::async_trait;
use eyre::Result;

/// Tool for handling the logic of what the next block range that should be
/// queried and may perform rate limiting on `next_range` queries.
#[async_trait]
pub trait SyncBlockRangeCursor {
    /// Returns the current `from` position of the scraper. Note that
    /// `next_range` may return a `from` value that is lower than this in order
    /// to have some overlap.
    fn current_position(&self) -> u32;

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
    async fn next_range(&mut self) -> Result<(u32, u32)>;

    /// If there was an issue when a range of data was fetched, this rolls back
    /// so the next range fetched will be from `start_from`. Note that it is a
    /// no-op if a later block value is specified.
    fn backtrack(&mut self, start_from: u32);
}
