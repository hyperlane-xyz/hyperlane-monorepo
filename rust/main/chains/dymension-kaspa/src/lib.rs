//! Implementation of hyperlane for the native kaspa module.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

#[allow(missing_docs)]
pub mod application;
mod consts;
mod error;
mod indexers;
mod ism;
#[allow(missing_docs)]
mod mailbox;
mod prometheus;
mod providers;
mod signers;
mod trait_builder;
mod validator_announce;

mod libs;
#[allow(missing_docs)]
pub mod hack;

// Direct reexports of lib stuff:
pub use dym_kas_relayer;
pub use dym_kas_validator;

pub use {
    self::error::*, self::indexers::*, self::ism::*, self::mailbox::*, self::providers::*,
    self::signers::*, self::trait_builder::*, self::validator_announce::*, self::hack::*,
};
