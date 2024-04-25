//! Implementation of hyperlane for Starknet.

#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![deny(warnings)]

pub use error::*;
pub use provider::*;
pub use signers::*;
pub use trait_builder::*;
pub use utils::*;

/// Generated contract bindings.
#[cfg(not(doctest))]
mod contracts;

mod error;
mod mailbox;
mod provider;
mod signers;
mod trait_builder;
mod utils;
