//! Implementation of hyperlane for fuel.

#![forbid(unsafe_code)]
#![warn(missing_docs)]
// TODO: Remove once we start filling things in
#![allow(unused_variables)]

pub use self::{
    aggregation_ism::*, indexer::*, interchain_gas::*, interchain_security_module::*, mailbox::*,
    merkle_tree_hook::*, multisig_ism::*, provider::*, routing_ism::*, trait_builder::*,
    validator_announce::*,
};

mod aggregation_ism;
mod contracts;
mod conversions;
mod indexer;
mod interchain_gas;
mod interchain_security_module;
mod mailbox;
mod merkle_tree_hook;
mod multisig_ism;
mod provider;
mod routing_ism;
mod trait_builder;
mod validator_announce;

/// Safe default imports of commonly used traits/types.
pub mod prelude {
    pub use crate::conversions::*;
}
