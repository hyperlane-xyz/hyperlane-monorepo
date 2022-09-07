//! A prometheus middleware to collect metrics.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

use ethers::prelude::U256;

mod contracts;

pub mod json_rpc_client;
pub mod middleware;

/// Convert a u256 scaled integer value into the corresponding f64 value.
fn u256_as_scaled_f64(value: U256, decimals: u8) -> f64 {
    value.to_f64_lossy() / (10u64.pow(decimals as u32) as f64)
}
