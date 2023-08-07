use std::{ops::RangeInclusive, time::Duration};

use async_trait::async_trait;
use auto_impl::auto_impl;

use crate::{ChainResult, LogMeta};

/// A cursor governs event indexing for a contract.
#[async_trait]
#[auto_impl(Box)]
pub trait ContractSyncCursor<T>: Send + Sync + 'static {
    /// The next block range that should be queried.
    async fn next_action(&mut self) -> ChainResult<(CursorAction, Duration)>;

    /// The latest block that has been queried
    fn latest_block(&self) -> u32;

    /// Ingests the logs that were fetched from the chain, and adjusts the cursor
    /// accordingly.
    async fn update(&mut self, logs: Vec<(T, LogMeta)>) -> eyre::Result<()>;
}

/// The action that should be taken by the contract sync loop
pub enum CursorAction {
    /// Direct the contract_sync task to query a block range (inclusive)
    Query(RangeInclusive<u32>),
    /// Direct the contract_sync task to sleep for a duration
    Sleep(Duration),
}
