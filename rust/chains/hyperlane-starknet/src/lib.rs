//! Implementation of hyperlane for Starknet.

#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![deny(warnings)]

pub use error::*;
pub use indexer::*;
pub use interchain_security_module::*;
pub use mailbox::*;
pub use multisig_ism::*;
pub use provider::*;
pub use signers::*;
pub use trait_builder::*;
pub use utils::*;
pub use validator_announce::*;

/// Generated contract bindings.
#[cfg(not(doctest))]
mod contracts;

mod error;
mod indexer;
mod interchain_security_module;
mod mailbox;
mod multisig_ism;
mod provider;
mod signers;
mod trait_builder;
mod utils;
mod validator_announce;
