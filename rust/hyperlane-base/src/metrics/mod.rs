//! Useful metrics that all agents should track.

pub use self::core::*;

/// The metrics namespace prefix. All metric names will start with `{NAMESPACE}_`.
pub const NAMESPACE: &str = "hyperlane";

// This should be whatever the prometheus scrape interval is
const METRICS_SCRAPE_INTERVAL: Duration = Duration::from_secs(60);

mod core;
use std::time::Duration;

pub mod agent;
mod json_rpc_client;
mod provider;
