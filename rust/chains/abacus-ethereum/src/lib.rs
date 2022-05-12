//! Interfaces to the ethereum contracts

#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![warn(unused_extern_crates)]

use std::sync::Arc;

use ethers::providers::Middleware;
use ethers::types::{Address, BlockId, BlockNumber, NameOrAddress, H160};
use eyre::Result;
use num::Num;

use abacus_core::*;
pub use retrying::{RetryingProvider, RetryingProviderError};

#[cfg(not(doctest))]
pub use crate::{inbox::*, outbox::*, validator_manager::*};

mod report_tx;

#[macro_use]
mod macros;

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
    ethers: ethers::providers::Provider<ethers::providers::Http>,
}

boxed_trait!(
    make_outbox_indexer,
    EthereumOutboxIndexer,
    OutboxIndexer,
    from_height: u32,
    chunk_size: u32
);
boxed_trait!(
    make_inbox_indexer,
    EthereumInboxIndexer,
    AbacusCommonIndexer,
    from_height: u32,
    chunk_size: u32
);
boxed_trait!(make_outbox, EthereumOutbox, Outbox,);
boxed_trait!(make_inbox, EthereumInbox, Inbox,);
boxed_trait!(
    make_inbox_validator_manager,
    EthereumInboxValidatorManager,
    InboxValidatorManager,
    inbox_address: Address
);

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
