//! Useful metrics that all agents should track.

/// The metrics namespace prefix. All metric names will start with `{NAMESPACE}_`.
pub const NAMESPACE: &str = "abacus";

mod core;
pub use self::core::*;

mod json_rpc_client;
mod provider;
