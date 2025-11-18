//! Implementation of hyperlane for aleo.

#![warn(missing_docs)]
#![deny(clippy::unwrap_used, clippy::panic)]
#![deny(clippy::arithmetic_side_effects)]

/// Hyperlane Application specific functionality
pub mod application;
mod config;
mod error;
mod provider;
mod types;
mod utils;

pub(crate) use types::*;

pub use {config::*, error::*, provider::AleoProvider};
