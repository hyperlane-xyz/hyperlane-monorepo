//! Implementation of hyperlane for fuel.

#![forbid(unsafe_code)]
#![warn(missing_docs)]
// TODO: Remove once we start filling things in
#![allow(unused_variables)]

pub use interchain_gas::*;
pub use mailbox::*;
pub use multisig_ism::*;
pub use provider::*;
pub use routing_ism::*;
pub use trait_builder::*;

mod contracts;
mod conversions;
mod interchain_gas;
mod mailbox;
mod multisig_ism;
mod provider;
mod routing_ism;
mod trait_builder;

/// Safe default imports of commonly used traits/types.
pub mod prelude {
    pub use crate::conversions::*;
}
