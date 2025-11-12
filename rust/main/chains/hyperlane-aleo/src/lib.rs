//! Implementation of hyperlane for aleo.

#![warn(missing_docs)]
#![deny(clippy::unwrap_used, clippy::panic)]
#![deny(clippy::arithmetic_side_effects)]

mod config;
mod error;
mod indexer;
mod provider;
mod types;
mod utils;

pub(crate) use types::*;

pub use {
    config::*, error::*, indexer::AleoDeliveryIndexer, indexer::AleoDispatchIndexer,
    indexer::AleoInterchainGasIndexer, indexer::AleoMerkleTreeHook, provider::AleoProvider,
};
