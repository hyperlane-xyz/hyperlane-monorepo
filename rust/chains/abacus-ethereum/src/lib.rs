//! Interfaces to the ethereum contracts

#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![warn(unused_extern_crates)]

use ethers::prelude::*;
use eyre::Result;
use num::Num;

use abacus_core::*;
pub use retrying::{RetryingProvider, RetryingProviderError};

use crate::trait_builder::build_trait;
#[cfg(not(doctest))]
pub use crate::{inbox::*, outbox::*, validator_manager::*};

#[cfg(not(doctest))]
mod tx;

#[cfg(not(doctest))]
mod trait_builder;

/// Outbox abi
#[cfg(not(doctest))]
mod outbox;

/// Inbox abi
#[cfg(not(doctest))]
mod inbox;

/// InboxValidatorManager abi
#[cfg(not(doctest))]
mod validator_manager;

/// Retrying Provider
mod retrying;

/// Ethereum connection configuration
#[derive(Debug, serde::Deserialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Connection {
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

impl Default for Connection {
    fn default() -> Self {
        Self::Http {
            url: Default::default(),
        }
    }
}

#[allow(dead_code)]
/// A live connection to an ethereum-compatible chain.
pub struct Chain {
    creation_metadata: Connection,
    ethers: Provider<Http>,
}

/// Cast a contract locator to a live contract handle
pub async fn make_outbox_indexer(
    conn: Connection,
    locator: &ContractLocator,
    signer: Option<Signers>,
    args: EthereumOutboxIndexerParams,
) -> Result<Box<dyn OutboxIndexer>> {
    build_trait(conn, locator, signer, args).await
}

// Cast a contract locator to a live contract handle
pub async fn make_inbox_indexer(
    conn: Connection,
    locator: &ContractLocator,
    signer: Option<Signers>,
    args: EthereumInboxIndexerParams,
) -> Result<Box<dyn AbacusCommonIndexer>> {
    build_trait(conn, locator, signer, args).await
}

// Cast a contract locator to a live contract handle
pub async fn make_outbox(
    conn: Connection,
    locator: &ContractLocator,
    signer: Option<Signers>,
    args: EthereumOutboxParams,
) -> Result<Box<dyn Outbox>> {
    build_trait(conn, locator, signer, args).await
}

// Cast a contract locator to a live contract handle
pub async fn make_inbox(
    conn: Connection,
    locator: &ContractLocator,
    signer: Option<Signers>,
    args: EthereumInboxArgs,
) -> Result<Box<dyn Inbox>> {
    build_trait(conn, locator, signer, args).await
}

// Cast a contract locator to a live contract handle
pub async fn make_inbox_validator_manager(
    conn: Connection,
    locator: &ContractLocator,
    signer: Option<Signers>,
    args: EthereumInboxValidatorManagerArgs,
) -> Result<Box<dyn InboxValidatorManager>> {
    build_trait(conn, locator, signer, args).await
}

#[async_trait::async_trait]
impl abacus_core::Chain for Chain {
    async fn query_balance(&self, addr: abacus_core::Address) -> Result<abacus_core::Balance> {
        let balance = format!(
            "{:x}",
            self.ethers
                .get_balance(
                    NameOrAddress::Address(H160::from_slice(&addr.0[..])),
                    Some(BlockId::Number(BlockNumber::Latest))
                )
                .await?
        );

        Ok(abacus_core::Balance(num::BigInt::from_str_radix(
            &balance, 16,
        )?))
    }
}
