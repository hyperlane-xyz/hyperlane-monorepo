//! Interfaces to the ethereum contracts

#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![warn(unused_extern_crates)]

use std::collections::HashMap;

use ethers::abi::FunctionExt;
use ethers::prelude::{
    abi, BlockId, BlockNumber, Http, Lazy, Middleware, NameOrAddress, Provider, Selector,
};

use hyperlane_core::*;
pub use retrying::{RetryingProvider, RetryingProviderError};

#[cfg(not(doctest))]
pub use crate::{interchain_gas::*, mailbox::*, multisig_ism::*, provider::*, trait_builder::*};

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

/// MultisigIsm abi
#[cfg(not(doctest))]
mod multisig_ism;

/// Generated contract bindings.
#[cfg(not(doctest))]
mod contracts;

/// Retrying Provider
mod retrying;

/// Ethereum connection configuration
#[derive(Debug, serde::Deserialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ConnectionConf {
    /// A HTTP-only quorum.
    HttpQuorum {
        /// List of fully qualified strings to connect to
        urls: String,
    },
    /// HTTP connection details
    Http {
        /// Fully qualified string to connect to
        url: String,
    },
    /// Websocket connection details
    Ws {
        /// Fully qualified string to connect to
        url: String,
    },
}

impl Default for ConnectionConf {
    fn default() -> Self {
        Self::Http {
            url: Default::default(),
        }
    }
}

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

fn extract_fn_map(abi: &'static Lazy<abi::Abi>) -> HashMap<Selector, &'static str> {
    abi.functions()
        .map(|f| (f.selector(), f.name.as_str()))
        .collect()
}
