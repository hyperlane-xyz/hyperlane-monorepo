//! A prometheus middleware to collect metrics.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

mod contracts;

#[deny(clippy::unwrap_used, clippy::panic)]
pub mod json_rpc_client;
#[deny(clippy::unwrap_used, clippy::panic)]
pub mod middleware;
