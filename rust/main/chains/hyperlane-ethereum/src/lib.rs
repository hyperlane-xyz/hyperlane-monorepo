//! Interfaces to the ethereum contracts

#![forbid(unsafe_code)]
#![warn(missing_docs)]

use std::collections::HashMap;

use ethers::abi::FunctionExt;
use ethers::prelude::{abi, Lazy, Middleware};

pub use self::{config::*, contracts::*, ism::*, rpc_clients::*, signer::*};

mod tx;

mod contracts;

mod ism;

/// Generated contract bindings.
mod interfaces;

/// Ethers JSONRPC Client implementations
mod rpc_clients;

mod signer;

mod config;
mod error;

fn extract_fn_map(abi: &'static Lazy<abi::Abi>) -> HashMap<Vec<u8>, &'static str> {
    abi.functions()
        .map(|f| (f.selector().to_vec(), f.name.as_str()))
        .collect()
}
