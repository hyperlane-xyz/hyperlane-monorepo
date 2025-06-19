//! Implementation of hyperlane for the native kaspa module.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

#[allow(missing_docs)]
pub mod application;
mod conf;
mod consts;
mod error;
mod indexers;
mod ism;
#[allow(missing_docs)]
mod mailbox;
mod prometheus;
mod providers;
mod signers;
mod validator_announce;

mod libs;

// Direct reexports of lib stuff:
pub use dym_kas_core;
pub use dym_kas_relayer;
pub use dym_kas_validator;

mod router;

pub use router;

pub use {
    self::conf::*, self::error::*, self::indexers::*, self::ism::*, self::mailbox::*,
    self::providers::*, self::signers::*, self::validator_announce::*,
};
