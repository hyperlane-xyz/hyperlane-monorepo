use std::time::Duration;

use crate::U256;

/// Interval for querying the prometheus metrics endpoint.
/// This should be whatever the prometheus scrape interval is
pub const METRICS_SCRAPE_INTERVAL: Duration = Duration::from_secs(60);

/// Convert a u256 scaled integer value into the corresponding f64 value.
#[cfg(feature = "float")]
pub fn u256_as_scaled_f64(value: U256, decimals: u8) -> f64 {
    value.to_f64_lossy() / (10u64.pow(decimals as u32) as f64)
}
