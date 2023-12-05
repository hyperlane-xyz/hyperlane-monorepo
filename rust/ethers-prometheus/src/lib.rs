//! A prometheus middleware to collect metrics.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

mod contracts;

pub mod json_rpc_client;
pub mod middleware;

/// Some basic information about a chain.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(tag = "type", rename_all = "camelCase"))]
pub struct ChainInfo {
    /// A human-friendly name for the chain. This should be a short string like
    /// "kovan".
    pub name: Option<String>,
}
