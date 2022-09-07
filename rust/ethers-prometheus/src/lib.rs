//! A prometheus middleware to collect metrics.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

use ethers::prelude::U256;

pub use middleware::*;

mod contracts;
mod middleware;

/// Uniform way to name the chain.
fn chain_name(chain: &Option<ChainInfo>) -> &str {
    chain
        .as_ref()
        .and_then(|c| c.name.as_deref())
        .unwrap_or("unknown")
}

/// Convert a u256 scaled integer value into the corresponding f64 value.
fn u256_as_scaled_f64(value: U256, decimals: u8) -> f64 {
    value.to_f64_lossy() / (10u64.pow(decimals as u32) as f64)
}
