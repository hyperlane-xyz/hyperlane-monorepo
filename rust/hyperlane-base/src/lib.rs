//! This repo contains a simple framework for building Hyperlane agents.
//! It has common utils and tools for configuring the app, interacting with the
//! smart contracts, etc.
//!
//! Implementations of the `Mailbox` traits on different chains
//! ought to live here.

// Forbid unsafe code outside of tests
#![cfg_attr(not(test), forbid(unsafe_code))]
#![warn(missing_docs)]

mod settings;
pub use settings::*;

/// Base trait for an agent
mod agent;
pub use agent::*;

#[doc(hidden)]
#[cfg_attr(tarpaulin, skip)]
#[macro_use]
pub mod macros;

/// mailbox type
mod mailbox;
pub use mailbox::*;

mod metrics;
pub use metrics::*;

mod contract_sync;
pub use contract_sync::*;

mod interchain_gas;
pub use interchain_gas::*;

mod traits;
pub use traits::*;

mod types;
pub use types::*;

/// Hyperlane database utils
pub mod db;

#[cfg(feature = "oneline-eyre")]
pub mod oneline_eyre;
