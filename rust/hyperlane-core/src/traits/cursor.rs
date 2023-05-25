use std::time::Duration;

use async_trait::async_trait;
use auto_impl::auto_impl;

use crate::{ChainResult, IndexRange, LogMeta};

/// A cursor governs event indexing for a contract.
#[async_trait]
#[auto_impl(Box)]
pub trait ContractSyncCursor<T>: Send + Sync + 'static {
    /// The next block range that should be queried.
    async fn next_range(&mut self) -> ChainResult<(IndexRange, Duration)>;

    /// Ingests the logs that were fetched from the chain, and adjusts the cursor
    /// accordingly.
    async fn update(&mut self, logs: Vec<(T, LogMeta)>) -> eyre::Result<()>;
}
