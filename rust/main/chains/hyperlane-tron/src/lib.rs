//! Interfaces to the ethereum contracts

#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![deny(clippy::unwrap_used, clippy::panic)]
#![deny(clippy::arithmetic_side_effects)]

use ethers_signers::LocalWallet;

pub use self::config::*;

mod config;

/// The signer type used for Tron chain interactions
/// This is an alias for `LocalWallet` from the `ethers_signers` crate
pub type TronSigner = LocalWallet;
