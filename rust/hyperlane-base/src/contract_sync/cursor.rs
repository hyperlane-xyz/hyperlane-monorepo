use std::time::{Duration, Instant};

use async_trait::async_trait;
use eyre::Result;
use tokio::time::sleep;
use tracing::warn;

use hyperlane_core::{ChainResult, Indexer, SyncBlockRangeCursor, SyncerEtaCalculator};

/// Time window for the moving average used in the eta calculator.
const ETA_TIME_WINDOW: f64 = 2. * 60.;

/// Tool for handling the logic of what the next block range that should be
/// queried is and also handling rate limiting. Rate limiting is automatically
/// performed by `next_range`.
pub struct RateLimitedSyncBlockRangeCursor<I> {
    indexer: I,
    tip: u32,
    last_tip_update: Instant,
    chunk_size: u32,
    from: u32,
    eta_calculator: SyncerEtaCalculator,
}

impl<I> RateLimitedSyncBlockRangeCursor<I>
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
            eta_calculator: SyncerEtaCalculator::new(initial_height, tip, ETA_TIME_WINDOW),
        })
    }

    /// Wait based on how close we are to the tip and update the tip,
    /// i.e. the highest block we may scrape.
    async fn rate_limit(&mut self) -> ChainResult<()> {
        let update_tip = self.last_tip_update.elapsed() >= Duration::from_secs(30);
        if self.from + self.chunk_size < self.tip {
            // If doing the full chunk wouldn't exceed the already known tip,
            // we don't necessarily need to fetch the new tip. Sleep a tiny bit
            // so that we can catch up to the tip relatively quickly.
            sleep(Duration::from_secs(1)).await;
        } else if !update_tip {
            // We are close to the tip.
            // Sleep a little longer because we have caught up.
            sleep(Duration::from_secs(10)).await;
        } else {
            // We are probably not caught up yet. This would happen if we
            // started really far behind so now it is very likely the tip
            // has moved a significant distance. We don't want to wait in
            // this case any more than we normally would.
            sleep(Duration::from_secs(1)).await;
        }

        if !update_tip {
            return Ok(());
        }
        match self.indexer.get_finalized_block_number().await {
            Ok(tip) => {
                // we retrieved a new tip value, go ahead and update.
                self.last_tip_update = Instant::now();
                self.tip = tip;
                Ok(())
            }
            Err(e) => {
                warn!(error = %e, "Failed to get next block range");
                // we are failing to make a basic query, we should wait before retrying.
                sleep(Duration::from_secs(10)).await;
                Err(e)
            }
        }
    }
}

#[async_trait]
impl<I: Indexer> SyncBlockRangeCursor for RateLimitedSyncBlockRangeCursor<I> {
    fn current_position(&self) -> u32 {
        self.from
    }

    fn tip(&self) -> u32 {
        self.tip
    }

    async fn next_range(&mut self) -> ChainResult<(u32, u32, Duration)> {
        self.rate_limit().await?;
        let to = u32::min(self.tip, self.from + self.chunk_size);
        let from = to.saturating_sub(self.chunk_size);
        self.from = to + 1;
        let mut eta = self.eta_calculator.calculate(from, self.tip);
        if to == self.tip {
            eta = Duration::from_secs(0);
        }
        Ok((from, to, eta))
    }

    fn backtrack(&mut self, start_from: u32) {
        self.from = u32::min(start_from, self.from);
    }
}
