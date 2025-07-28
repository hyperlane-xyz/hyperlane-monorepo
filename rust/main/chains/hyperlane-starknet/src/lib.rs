//! Implementation of hyperlane for Starknet.

#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![deny(warnings)]

pub use error::*;
pub use indexer::*;
pub use interchain_gas::*;
pub use ism::*;
pub use mailbox::*;
pub use merkle_tree_hook::*;
pub use provider::*;
pub use signers::*;
pub use trait_builder::*;
pub use utils::*;
pub use validator_announce::*;

#[allow(clippy::all)]
#[rustfmt::skip]
pub mod contracts;

/// Application specific functionality
#[deny(clippy::unwrap_used, clippy::panic)]
pub mod application;
#[deny(clippy::unwrap_used, clippy::panic)]
mod error;
#[deny(clippy::unwrap_used, clippy::panic)]
mod indexer;
#[deny(clippy::unwrap_used, clippy::panic)]
mod interchain_gas;
#[deny(clippy::unwrap_used, clippy::panic)]
mod ism;
#[deny(clippy::unwrap_used, clippy::panic)]
mod mailbox;
#[deny(clippy::unwrap_used, clippy::panic)]
mod merkle_tree_hook;
#[deny(clippy::unwrap_used, clippy::panic)]
mod provider;
#[deny(clippy::unwrap_used, clippy::panic)]
mod signers;
#[deny(clippy::unwrap_used, clippy::panic)]
mod trait_builder;
#[deny(clippy::unwrap_used, clippy::panic)]
mod types;
#[deny(clippy::unwrap_used, clippy::panic)]
mod utils;
#[deny(clippy::unwrap_used, clippy::panic)]
mod validator_announce;
