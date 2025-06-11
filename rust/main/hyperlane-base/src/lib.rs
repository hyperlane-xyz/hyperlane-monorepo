//! This repo contains a simple framework for building Hyperlane agents.
//! It has common utils and tools for configuring the app, interacting with the
//! smart contracts, etc.

// Forbid unsafe code outside of tests
#![cfg_attr(not(test), forbid(unsafe_code))]
#![warn(missing_docs)]

pub mod settings;

/// Base trait for an agent
mod agent;
pub use agent::*;

/// The local cache used by agents
pub mod cache;
/// The local database used by agents
pub mod db;

mod metadata;

pub mod metrics;
pub use metrics::*;

/// Hyperlane server utils
pub mod server;

mod contract_sync;
pub use contract_sync::*;

mod traits;
pub use traits::*;

mod types;
pub use types::*;

#[cfg(feature = "oneline-eyre")]
pub mod oneline_eyre;
