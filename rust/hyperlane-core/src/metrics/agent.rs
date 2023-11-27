use std::collections::HashMap;

use async_trait::async_trait;
use derive_new::new;
use eyre::Result;

use crate::{ChainResult, U256};

#[async_trait]
pub trait AgenMetricsFetcher {
    async fn get_balance(&self) -> ChainResult<U256>;
}

// /// Convert a u256 scaled integer value into the corresponding f64 value.
// fn u256_as_scaled_f64(value: U256, decimals: u8) -> f64 {
//     value.to_f64_lossy() / (10u64.pow(decimals as u32) as f64)
// }
