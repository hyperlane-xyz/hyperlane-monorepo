//! This repo contains a simple framework for building Hyperlane agents.
//! It has common utils and tools for configuring the app, interacting with the
//! smart contracts, etc.
//!
//! Implementations of the `Outbox` and `Inbox` traits on different chains
//! ought to live here.

#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![warn(unused_extern_crates)]

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

mod multisig_ism;
pub use multisig_ism::*;

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

#[cfg(feature = "oneline-eyre")]
pub mod oneline_eyre;
