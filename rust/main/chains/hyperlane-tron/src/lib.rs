//! Interfaces to the ethereum contracts

#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![deny(clippy::unwrap_used, clippy::panic)]
#![deny(clippy::arithmetic_side_effects)]

use ethers_signers::LocalWallet;

pub use {
    config::ConnectionConf, contracts::TronInterchainGasPaymaster, contracts::TronMailbox,
    contracts::TronMailboxIndexer, contracts::TronMerkleTreeHookIndexer, ism::TronAggregationIsm,
    ism::TronInterchainSecurityModule, ism::TronMultisigIsm, ism::TronRoutingIsm,
    provider::TronProvider,
};

mod config;
mod contracts;
mod error;
mod ism;
mod provider;
mod utils;

#[allow(clippy::unwrap_used)]
mod interfaces;

/// The signer type used for Tron chain interactions
/// This is an alias for `LocalWallet` from the `ethers_signers` crate
pub type TronSigner = LocalWallet;

pub(crate) use {config::*, contracts::*, error::*, provider::*, utils::*};
