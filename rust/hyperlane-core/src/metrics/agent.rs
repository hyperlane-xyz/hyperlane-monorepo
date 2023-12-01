use std::time::Duration;

use async_trait::async_trait;

use crate::{ChainResult, U256};

/// Interval for querying the prometheus metrics endpoint.
/// This should be whatever the prometheus scrape interval is
pub const METRICS_SCRAPE_INTERVAL: Duration = Duration::from_secs(60);

/// Trait to be implemented by all chain-specific agent implementations,
/// to support gathering agent metrics.
#[async_trait]
pub trait AgentMetricsFetcher: Send + Sync {
    /// Fetch the balance of the wallet address associated with the chain provider.
    async fn get_balance(&self, address: String) -> ChainResult<U256>;
}

/// Convert a u256 scaled integer value into the corresponding f64 value.
#[cfg(feature = "float")]
pub fn u256_as_scaled_f64(value: U256, decimals: u8) -> f64 {
    value.to_f64_lossy() / (10u64.pow(decimals as u32) as f64)
}
