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

pub use config::*;
pub use error::*;
pub use indexer::{
    AleoDeliveryIndexer, AleoDispatchIndexer, AleoInterchainGasIndexer, AleoMerkleTreeHook,
};
pub use ism::AleoIsm;
pub use mailbox::AleoMailbox;
pub use provider::{AleoProvider, AleoProviderForLander};
pub use signer::AleoSigner;
pub use types::{AleoGetMappingValue, AleoTxData, CurrentNetwork, FeeEstimate};
pub use validator_announce::AleoValidatorAnnounce;

pub use snarkvm::ledger::{
    ConfirmedTransaction as AleoConfirmedTransaction, Transaction as AleoUnconfirmedTransaction,
};
pub use snarkvm::prelude::Plaintext;
