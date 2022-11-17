// TODO: Reapply tip buffer
// TODO: Reapply metrics

use std::time::{Duration, Instant};

use eyre::Result;
use tokio::time::sleep;

use abacus_core::db::AbacusDB;
use abacus_core::Indexer;
pub use interchain_gas::*;
pub use metrics::ContractSyncMetrics;
pub use outbox::*;

use crate::settings::IndexSettings;

mod interchain_gas;
/// Tools for working with message continuity.
pub mod last_message;
mod metrics;
mod outbox;
mod schema;

/// Entity that drives the syncing of an agent's db with on-chain data.
/// Extracts chain-specific data (emitted checkpoints, messages, etc) from an
/// `indexer` and fills the agent's db with this data. A CachingOutbox or
/// CachingInbox will use a contract sync to spawn syncing tasks to keep the
/// db up-to-date.
#[derive(Debug)]
pub struct ContractSync<I> {
    chain_name: String,
    db: AbacusDB,
    indexer: I,
    index_settings: IndexSettings,
    metrics: ContractSyncMetrics,
}

impl<I> ContractSync<I> {
    /// Instantiate new ContractSync
    pub fn new(
        chain_name: String,
        db: AbacusDB,
        indexer: I,
        index_settings: IndexSettings,
        metrics: ContractSyncMetrics,
    ) -> Self {
        Self {
            chain_name,
            db,
            indexer,
            index_settings,
            metrics,
        }
    }
}

/// Tool for handling the logic of what the next block range that should be
/// queried is and also handing rate limiting. Rate limiting is automatically
/// performed by `next_range`.
pub struct ContractSyncHelper<I> {
    indexer: I,
    tip: u32,
    last_tip_update: Instant,
    chunk_size: u32,
    from: u32,
}

impl<I> ContractSyncHelper<I>
where
    I: Indexer,
{
    /// Construct a new contract sync helper.
    pub async fn new(indexer: I, chunk_size: u32, initial_height: u32) -> Result<Self> {
        let tip = indexer.get_finalized_block_number().await?;
        Ok(Self {
            indexer,
            tip,
            chunk_size,
            last_tip_update: Instant::now(),
            from: initial_height,
        })
    }

    /// Returns the current `from` position of the scraper. Note that
    /// `next_range` may return a `from` value that is lower than this in order
    /// to have some overlap.
    pub fn current_position(&self) -> u32 {
        self.from
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
    pub async fn next_range(&mut self) -> Result<(u32, u32)> {
        self.rate_limit().await?;
        let to = u32::min(self.tip, self.from + self.chunk_size);
        let from = to.saturating_sub(self.chunk_size);
        self.from = to + 1;
        Ok((from, to))
    }

    /// If there was an issue when a range of data was fetched, this rolls back
    /// so the next range fetched will be from `start_from`. Note that it is a
    /// no-op if a later block value is specified.
    pub fn backtrack(&mut self, start_from: u32) {
        self.from = u32::min(start_from, self.from);
    }

    /// Wait based on how close we are to the tip and update the tip,
    /// i.e. the highest block we may scrape.
    async fn rate_limit(&mut self) -> Result<()> {
        if self.from + self.chunk_size < self.tip {
            // If doing the full chunk wouldn't exceed the already known tip,
            // we don't necessarily need to fetch the new tip. Sleep a tiny bit
            // so that we can catch up to the tip relatively quickly.
            sleep(Duration::from_secs(1)).await;
            Ok(())
        } else {
            // We are close to the tip.
            if (Instant::now() - self.last_tip_update) < Duration::from_secs(30) {
                // Sleep a little longer because we have caught up.
                sleep(Duration::from_secs(10)).await;
            } else {
                // We are probably not caught up yet. This would happen if we
                // started really far behind so now it is very likely the tip
                // has moved a significant distance. We don't want to wait in
                // this case any more than we normally would.
                sleep(Duration::from_secs(1)).await;
            }

            match self.indexer.get_finalized_block_number().await {
                Ok(tip) => {
                    // we retrieved a new tip value, go ahead and update.
                    self.last_tip_update = Instant::now();
                    self.tip = tip;
                    Ok(())
                }
                Err(e) => {
                    // we are failing to make a basic query, we should wait before retrying.
                    sleep(Duration::from_secs(10)).await;
                    Err(e)
                }
            }
        }
    }
}
