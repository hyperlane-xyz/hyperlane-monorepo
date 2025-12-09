//! Implementation of hyperlane for the native kaspa module.

#![forbid(unsafe_code)]
// #![warn(missing_docs)]

#[allow(missing_docs)]
pub mod application;
pub mod conf;
pub mod consts;
mod error;
mod indexers;
mod ism;
#[allow(missing_docs)]
mod mailbox;
mod prometheus;
mod providers;
mod validator_announce;

mod endpoints;

mod util;
mod withdrawal_utils;

pub mod ops;
pub mod kas_relayer;
pub mod kas_validator;

// Direct reexports of lib stuff:
pub use dym_kas_core;
pub use consts as hl_domains;

// Re-export message module from ops as hl_message for semantic clarity
pub use ops::message as hl_message;

pub use util::*;

pub use {
    self::conf::*, self::error::*, self::indexers::*, self::ism::*, self::mailbox::*,
    self::providers::*, self::validator_announce::*, self::kas_validator::server::*,
    self::withdrawal_utils::*,
};
