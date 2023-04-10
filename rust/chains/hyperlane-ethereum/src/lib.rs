//! Interfaces to the ethereum contracts

#![forbid(unsafe_code)]
#![warn(missing_docs)]

use std::collections::HashMap;

use ethers::abi::FunctionExt;
use ethers::prelude::{abi, BlockId, BlockNumber, Http, Lazy, Middleware, NameOrAddress, Provider};

use hyperlane_core::{Address, Balance, ChainCommunicationError, ChainResult, H160};

#[cfg(not(doctest))]
pub use self::{
    config::*, interchain_gas::*, interchain_security_module::*, mailbox::*, multisig_ism::*,
    provider::*, rpc_clients::*, signers::*, trait_builder::*, validator_announce::*,
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

#[allow(dead_code)]
/// A live connection to an ethereum-compatible chain.
pub struct Chain {
    creation_metadata: ConnectionConf,
    ethers: Provider<Http>,
}

#[async_trait::async_trait]
impl hyperlane_core::Chain for Chain {
    async fn query_balance(&self, addr: Address) -> ChainResult<Balance> {
        use num::{BigInt, Num};

        let balance = format!(
            "{:x}",
            self.ethers
                .get_balance(
                    NameOrAddress::Address(H160::from_slice(&addr.0[..])),
                    Some(BlockId::Number(BlockNumber::Latest))
                )
                .await?
        );
        let balance =
            BigInt::from_str_radix(&balance, 16).map_err(ChainCommunicationError::from_other)?;

        Ok(Balance(balance))
    }
}

fn extract_fn_map(abi: &'static Lazy<abi::Abi>) -> HashMap<Vec<u8>, &'static str> {
    abi.functions()
        .map(|f| (f.selector().to_vec(), f.name.as_str()))
        .collect()
}
