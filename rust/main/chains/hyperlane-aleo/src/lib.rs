//! Implementation of hyperlane for aleo.

#![warn(missing_docs)]
#![deny(clippy::unwrap_used, clippy::panic)]
#![deny(clippy::arithmetic_side_effects)]

/// Hyperlane Application specific functionality
pub mod application;
mod config;
mod error;
mod indexer;
mod ism;
mod mailbox;
mod provider;
mod signer;
mod types;
mod utils;
mod validator_announce;

pub(crate) use types::*;

pub use {
    config::*, error::*, indexer::AleoDeliveryIndexer, indexer::AleoDispatchIndexer,
    indexer::AleoInterchainGasIndexer, indexer::AleoMerkleTreeHook, ism::AleoIsm,
    mailbox::AleoMailbox, provider::AleoProvider, signer::AleoSigner,
    validator_announce::AleoValidatorAnnounce,
};
