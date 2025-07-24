//! A prometheus middleware to collect metrics.

#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![deny(clippy::unwrap_used, clippy::panic)]

#[allow(clippy::unwrap_used)]
mod contracts;

pub mod json_rpc_client;
pub mod middleware;
