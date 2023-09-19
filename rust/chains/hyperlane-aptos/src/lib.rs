//! Implementation of hyperlane for Aptos.

#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![deny(warnings)]

pub use crate::multisig_ism::*;
pub use client::AptosClient;
pub use interchain_gas::*;
pub use interchain_security_module::*;
pub use mailbox::*;
pub use provider::*;
pub use solana_sdk::signer::keypair::Keypair;
pub use trait_builder::*;
pub use types::*;
pub use utils::*;
pub use validator_announce::*;

mod interchain_gas;
mod interchain_security_module;
mod mailbox;
mod multisig_ism;
mod provider;
mod trait_builder;
mod types;
mod utils;

mod client;
mod validator_announce;
