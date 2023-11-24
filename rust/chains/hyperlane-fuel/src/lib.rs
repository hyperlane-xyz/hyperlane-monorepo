//! Implementation of hyperlane for fuel.

#![forbid(unsafe_code)]
#![warn(missing_docs)]
// TODO: Remove once we start filling things in
#![allow(unused_variables)]

pub use self::{
    interchain_gas::*, mailbox::*, multisig_ism::*, provider::*, routing_ism::*, trait_builder::*,
    validator_announce::*,
};

mod contracts;
mod conversions;
mod interchain_gas;
mod mailbox;
mod multisig_ism;
mod provider;
mod routing_ism;
mod trait_builder;
mod validator_announce;

/// Safe default imports of commonly used traits/types.
pub mod prelude {
    pub use crate::conversions::*;
}
