use std::time::{Duration, Instant};

use async_trait::async_trait;
use auto_impl::auto_impl;
use derive_new::new;
use num_traits::Zero;

use crate::ChainResult;

/// Calculates the expected time to catch up to the tip of the blockchain.
#[derive(new)]
pub struct SyncerEtaCalculator {
    #[new(value = "Instant::now()")]
    last_time: Instant,

    last_block: u32,
    last_tip: u32,

    #[new(default)]
    last_eta: Duration,
    /// Block processing rate less the tip progression rate. It works
    /// mathematically to have both rates merged as we are using a moving
    /// average so partial updates will not overwrite
    #[new(default)]
    effective_rate: Option<f64>,
    /// How long we want the data to "survive" for in the moving average.
    time_window: f64,
}

impl SyncerEtaCalculator {
    /// Calculate the expected time to catch up to the tip of the blockchain.
    pub fn calculate(&mut self, current_block: u32, current_tip: u32) -> Duration {
        let now = Instant::now();
        let elapsed = now.duration_since(self.last_time).as_secs_f64();
        self.last_time = now;

        let blocks_processed = (current_block - self.last_block) as f64;
        let tip_progression = (current_tip - self.last_tip) as f64;

        self.last_block = current_block;
        self.last_tip = current_tip;
        let new_rate = (blocks_processed - tip_progression) / elapsed;

        // Calculate the effective rate using a moving average. Only set the past
        // effective rate once we have seen a move to prevent it taking a long
        // time to normalize.
        let effective_rate = if let Some(old_rate) = self.effective_rate {
            let new_coeff = (elapsed / self.time_window).min(0.9);
            let old_coeff = 1. - new_coeff;

            let er = new_rate * new_coeff + old_rate * old_coeff;
            self.effective_rate = Some(er);
            er
        } else {
            if !new_rate.is_zero() {
                self.effective_rate = Some(new_rate);
            }
            new_rate
        };

        self.last_eta = if effective_rate <= 0. {
            // max out at 1yr if we are behind
            Duration::from_secs_f64(60. * 60. * 24. * 365.25)
        } else {
            Duration::from_secs_f64((current_tip - current_block) as f64 / effective_rate)
        };

        self.last_eta
    }

    /// Returns the last calculated eta offset by how long it has been since it
    /// was generated.
    pub fn eta(&self) -> Duration {
        let elapsed = Instant::now().duration_since(self.last_time);
        self.last_eta.saturating_sub(elapsed)
    }
}

/// Tool for handling the logic of what the next block range that should be
/// queried and may perform rate limiting on `next_range` queries.
#[async_trait]
#[auto_impl(Box)]
pub trait SyncBlockRangeCursor {
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
    async fn next_range(&mut self) -> ChainResult<(u32, u32, Duration)>;

    /// If there was an issue when a range of data was fetched, this rolls back
    /// so the next range fetched will be from `start_from`. Note that it is a
    /// no-op if a later block value is specified.
    fn backtrack(&mut self, start_from: u32);
}
