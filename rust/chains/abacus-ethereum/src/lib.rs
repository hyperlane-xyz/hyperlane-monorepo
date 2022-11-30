//! Interfaces to the ethereum contracts

#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![warn(unused_extern_crates)]

use std::collections::HashMap;

use ethers::prelude::*;
use eyre::Result;
use num::Num;

use abacus_core::*;
pub use retrying::{RetryingProvider, RetryingProviderError};

use crate::abi::FunctionExt;
#[cfg(not(doctest))]
pub use crate::{
    dynamic::*, interchain_gas::*, mailbox::*, multisig_ism::*, provider::*, provider_init::*,
};

#[cfg(not(doctest))]
mod tx;

/// Outbox abi
#[cfg(not(doctest))]
mod mailbox;

#[cfg(not(doctest))]
mod provider_init;

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

/// Dynamic Middleware Wrapper
mod dynamic;

/// Ethereum connection configuration
#[derive(Debug, serde::Deserialize, Clone, Hash, Eq, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ConnectionConfig {
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

impl Default for ConnectionConfig {
    fn default() -> Self {
        Self::Http {
            url: Default::default(),
        }
    }
}

#[allow(dead_code)]
/// A live connection to an ethereum-compatible chain.
pub struct Chain {
    creation_metadata: ConnectionConfig,
    ethers: Provider<Http>,
}

#[async_trait::async_trait]
impl abacus_core::Chain for Chain {
    async fn query_balance(&self, addr: abacus_core::Address) -> Result<Balance> {
        let balance = format!(
            "{:x}",
            self.ethers
                .get_balance(
                    NameOrAddress::Address(H160::from_slice(&addr.0[..])),
                    Some(BlockId::Number(BlockNumber::Latest))
                )
                .await?
        );

        Ok(Balance(num::BigInt::from_str_radix(&balance, 16)?))
    }
}

fn extract_fn_map(abi: &'static Lazy<abi::Abi>) -> HashMap<Selector, &'static str> {
    abi.functions()
        .map(|f| (f.selector(), f.name.as_str()))
        .collect()
}
