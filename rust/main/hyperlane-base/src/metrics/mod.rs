//! Useful metrics that all agents should track.

pub use self::core::*;

/// The metrics namespace prefix. All metric names will start with `{NAMESPACE}_`.
pub const NAMESPACE: &str = "hyperlane";

mod core;

mod agent_metrics;
mod cache;
mod json_rpc_client;
mod provider;

pub use self::agent_metrics::*;
