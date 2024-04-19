//! Implementation of hyperlane for Starknet.

#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![deny(warnings)]

pub use provider::*;
pub use trait_builder::*;

mod mailbox;
mod provider;
mod trait_builder;
