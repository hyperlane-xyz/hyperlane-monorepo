use std::{
    fmt::{self, Debug},
    ops::RangeInclusive,
    time::Duration,
};

use async_trait::async_trait;
use auto_impl::auto_impl;
use eyre::Result;

use crate::{Indexed, LogMeta};

/// A cursor governs event indexing for a contract.
#[async_trait]
#[auto_impl(Box)]
pub trait ContractSyncCursor<T>: Debug + Send + Sync + 'static {
    /// The next block range that should be queried.
    /// This method should be tolerant to being called multiple times in a row
    /// without any updates in between.
    async fn next_action(&mut self) -> Result<(CursorAction, Duration)>;

    /// The latest block that has been queried, used as a proxy for health.
    /// TODO: consider a better way to assess health
    fn latest_queried_block(&self) -> u32;

    /// Ingests the logs that were fetched from the chain and the range that was queried,
    /// and adjusts the cursor accordingly.
    /// This is called after the logs have been written to the store,
    /// however may require logs to meet certain criteria (e.g. no gaps), that if
    /// not met, should result in internal state changes (e.g. rewinding) and not an Err.
    async fn update(
        &mut self,
        logs: Vec<(Indexed<T>, LogMeta)>,
        range: RangeInclusive<u32>,
    ) -> Result<()>;
}

/// The action that should be taken by the contract sync loop
pub enum CursorAction {
    /// Direct the contract_sync task to query a block range (inclusive)
    Query(RangeInclusive<u32>),
    /// Direct the contract_sync task to sleep for a duration
    Sleep(Duration),
}

impl fmt::Debug for CursorAction {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CursorAction::Query(range) => write!(f, "Query({:?})", range),
            CursorAction::Sleep(duration) => write!(f, "Sleep({:?})", duration),
        }
    }
}
