//! Interfaces to the ethereum contracts

#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![deny(clippy::unwrap_used, clippy::panic)]
<<<<<<< HEAD
=======
#![deny(clippy::arithmetic_side_effects)]
>>>>>>> main

use std::collections::HashMap;

use ethers::abi::FunctionExt;
use ethers::prelude::{abi, Lazy, Middleware};

pub use self::{config::*, contracts::*, ism::*, rpc_clients::*, signer::*};

/// Hyperlane Application specific functionality
pub mod application;
mod config;
mod error;
mod ism;
/// Ethers JSONRPC Client implementations
mod rpc_clients;
mod signer;
mod tx;

<<<<<<< HEAD
#[allow(clippy::unwrap_used)]
=======
#[allow(clippy::arithmetic_side_effects, clippy::unwrap_used)]
>>>>>>> main
mod contracts;
#[allow(clippy::unwrap_used)]
mod interfaces;

fn extract_fn_map(abi: &'static Lazy<abi::Abi>) -> HashMap<Vec<u8>, &'static str> {
    abi.functions()
        .map(|f| (f.selector().to_vec(), f.name.as_str()))
        .collect()
}
