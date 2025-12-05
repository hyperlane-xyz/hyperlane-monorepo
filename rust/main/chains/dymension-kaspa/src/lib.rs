//! Implementation of hyperlane for the native kaspa module.

#![forbid(unsafe_code)]
// #![warn(missing_docs)]

#[allow(missing_docs)]
pub mod application;
pub mod conf;
mod consts;
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

pub mod kas_bridge;
pub mod kas_relayer;
pub mod kas_validator;

// Direct reexports of lib stuff:
pub use dym_kas_core;
pub use dymension_kaspa_hl_constants as hl_domains;

// Re-export message module from kas_bridge as hl_message for semantic clarity
pub use kas_bridge::message as hl_message;

pub use util::*;

mod validator_server;

pub use {
    self::conf::*, self::error::*, self::indexers::*, self::ism::*, self::mailbox::*,
    self::providers::*, self::validator_announce::*, self::validator_server::*,
    self::withdrawal_utils::*,
};
