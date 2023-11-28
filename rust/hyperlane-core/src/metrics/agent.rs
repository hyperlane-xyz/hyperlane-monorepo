use std::{collections::HashMap, time::Duration};

use async_trait::async_trait;

use crate::{ChainResult, U256};

// This should be whatever the prometheus scrape interval is
pub const METRICS_SCRAPE_INTERVAL: Duration = Duration::from_secs(60);

#[async_trait]
pub trait AgenMetricsFetcher: Send + Sync {
    async fn get_balance(&self) -> ChainResult<U256>;
}

// /// Convert a u256 scaled integer value into the corresponding f64 value.
// fn u256_as_scaled_f64(value: U256, decimals: u8) -> f64 {
//     value.to_f64_lossy() / (10u64.pow(decimals as u32) as f64)
// }
