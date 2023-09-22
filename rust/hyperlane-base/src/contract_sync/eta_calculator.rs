use std::time::{Duration, Instant};

use derive_new::new;
use tracing::warn;

/// Calculates the expected time to catch up to the tip of the blockchain.
#[derive(new)]
pub(crate) struct SyncerEtaCalculator {
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

        // It was observed that this function can be called with a `last_block` that is greater
        // than the `currenct_block`, which results in an underflow. Use saturating math to
        // prevent this.
        let blocks_processed = current_block.saturating_sub(self.last_block) as f64;
        let tip_progression = current_tip.saturating_sub(self.last_tip) as f64;

        self.last_block = current_block;
        self.last_tip = current_tip;

        // The block-processing rate, minus the tip-progression rate, measured in
        // blocks per second.
        let new_rate = (blocks_processed - tip_progression) / elapsed;

        // Calculate the effective rate using a moving average. Only set the past
        // effective rate once we have seen a move, to prevent it taking a long
        // time to normalize.
        let effective_rate = if let Some(old_rate) = self.effective_rate {
            let new_coeff = f64::min(elapsed / self.time_window, 0.9);
            let old_coeff = 1. - new_coeff;

            let er = (new_rate * new_coeff) + (old_rate * old_coeff);
            self.effective_rate = Some(er);
            er
        } else {
            if new_rate != 0. {
                self.effective_rate = Some(new_rate);
            }
            new_rate
        };

        let default_duration = Duration::from_secs_f64(60. * 60. * 24. * 365.25);
        self.last_eta = if effective_rate <= 0. {
            // max out at 1yr if we are behind
            default_duration
        } else {
            match Duration::try_from_secs_f64((current_tip - current_block) as f64 / effective_rate)
            {
                Ok(eta) => eta,
                Err(e) => {
                    warn!(error=?e, tip=?current_tip, block=?current_block, rate=?effective_rate, "Failed to calculate the eta");
                    default_duration
                }
            }
        };

        self.last_eta
    }
}
