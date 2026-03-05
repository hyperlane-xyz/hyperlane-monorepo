//! Interfaces to the ethereum contracts

#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![deny(clippy::unwrap_used, clippy::panic)]
#![deny(clippy::arithmetic_side_effects)]

pub use {
    config::ConnectionConf,
    contracts::TronInterchainGasPaymaster,
    contracts::TronMailbox,
    contracts::TronMailboxIndexer,
    contracts::TronMerkleTreeHook,
    contracts::TronMerkleTreeHookIndexer,
    contracts::TronValidatorAnnounce,
    ism::TronAggregationIsm,
    ism::TronInterchainSecurityModule,
    ism::TronMultisigIsm,
    ism::TronRoutingIsm,
    provider::TronProvider,
    provider::TronProviderForLander,
    signer::{TronSigners, TronSignersError},
};

mod config;
mod contracts;
mod error;
mod ism;
mod provider;
mod signer;
mod utils;

#[allow(clippy::unwrap_used)]
mod interfaces;

/// The signer type used for Tron chain interactions
pub type TronSigner = TronSigners;

pub(crate) use {config::*, contracts::*, error::*, provider::*, utils::*};
