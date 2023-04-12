use std::cmp;
use std::time::{Duration, Instant};

use derive_new::new;

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

        let blocks_processed = (current_block - self.last_block) as f64;
        let tip_progression = (current_tip - self.last_tip) as f64;

        self.last_block = current_block;
        self.last_tip = current_tip;
        let new_rate = (blocks_processed - tip_progression) / elapsed;

        // Calculate the effective rate using a moving average. Only set the past
        // effective rate once we have seen a move to prevent it taking a long
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

        self.last_eta = if effective_rate <= 0. {
            // max out at 1yr if we are behind
            Duration::from_secs_f64(60. * 60. * 24. * 365.25)
        } else {
            Duration::from_secs_f64((current_tip - current_block) as f64 / effective_rate)
        };

        self.last_eta
    }
}
