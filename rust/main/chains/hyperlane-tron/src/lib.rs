//! Interfaces to the ethereum contracts

#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![deny(clippy::unwrap_used, clippy::panic)]
#![deny(clippy::arithmetic_side_effects)]

use ethers_signers::LocalWallet;

pub use {config::ConnectionConf, provider::TronProvider};

mod config;
mod error;
mod provider;
mod utils;

/// The signer type used for Tron chain interactions
/// This is an alias for `LocalWallet` from the `ethers_signers` crate
pub type TronSigner = LocalWallet;

pub(crate) use {config::*, error::*, provider::*, utils::*};
