//! Interfaces to the ethereum contracts

#![forbid(unsafe_code)]
#![warn(missing_docs)]

use std::collections::HashMap;

use ethers::abi::FunctionExt;
use ethers::prelude::{abi, Lazy, Middleware};

#[cfg(not(doctest))]
pub use self::{
    config::*, interchain_gas::*, interchain_security_module::*, mailbox::*, multisig_ism::*,
    provider::*, routing_ism::*, rpc_clients::*, signers::*, trait_builder::*,
    validator_announce::*,
};

#[cfg(not(doctest))]
mod tx;

/// Mailbox abi
#[cfg(not(doctest))]
mod mailbox;

#[cfg(not(doctest))]
mod trait_builder;

/// Provider abi
#[cfg(not(doctest))]
mod provider;

/// InterchainGasPaymaster abi
#[cfg(not(doctest))]
mod interchain_gas;

/// interchain_security_module abi
#[cfg(not(doctest))]
mod interchain_security_module;

/// MultisigIsm abi
#[cfg(not(doctest))]
mod multisig_ism;

/// RoutingIsm abi
#[cfg(not(doctest))]
mod routing_ism;

/// ValidatorAnnounce abi
#[cfg(not(doctest))]
mod validator_announce;

/// Generated contract bindings.
#[cfg(not(doctest))]
mod contracts;

/// Ethers JSONRPC Client implementations
mod rpc_clients;

mod signers;

mod config;

fn extract_fn_map(abi: &'static Lazy<abi::Abi>) -> HashMap<Vec<u8>, &'static str> {
    abi.functions()
        .map(|f| (f.selector().to_vec(), f.name.as_str()))
        .collect()
}
