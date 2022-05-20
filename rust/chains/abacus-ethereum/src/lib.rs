//! Interfaces to the ethereum contracts

#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![warn(unused_extern_crates)]

use ethers::prelude::*;
use eyre::Result;
use num::Num;

use abacus_core::*;
pub use retrying::{RetryingProvider, RetryingProviderError};

use crate::trait_builder::MakeableWithProvider;
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
    builder: &OutboxIndexerConfig,
) -> Result<Box<dyn OutboxIndexer>> {
    builder.make_with_connection(conn, locator, signer).await
}

/// Cast a contract locator to a live contract handle
pub async fn make_inbox_indexer(
    conn: Connection,
    locator: &ContractLocator,
    signer: Option<Signers>,
    builder: &InboxIndexerConfig,
) -> Result<Box<dyn AbacusCommonIndexer>> {
    builder.make_with_connection(conn, locator, signer).await
}

/// Cast a contract locator to a live contract handle
pub async fn make_outbox(
    conn: Connection,
    locator: &ContractLocator,
    signer: Option<Signers>,
    builder: &OutboxConfig,
) -> Result<Box<dyn Outbox>> {
    builder.make_with_connection(conn, locator, signer).await
}

/// Cast a contract locator to a live contract handle
pub async fn make_inbox(
    conn: Connection,
    locator: &ContractLocator,
    signer: Option<Signers>,
    builder: &InboxConfig,
) -> Result<Box<dyn Inbox>> {
    builder.make_with_connection(conn, locator, signer).await
}

/// Cast a contract locator to a live contract handle
pub async fn make_inbox_validator_manager(
    conn: Connection,
    locator: &ContractLocator,
    signer: Option<Signers>,
    builder: &InboxValidatorManagerConfig,
) -> Result<Box<dyn InboxValidatorManager>> {
    builder.make_with_connection(conn, locator, signer).await
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
