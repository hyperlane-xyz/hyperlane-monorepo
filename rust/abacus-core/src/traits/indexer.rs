//! An Indexer provides a common interface for bubbling up chain-specific
//! event-data to another entity (e.g. a `ContractSync`). For example, the only
//! way to retrieve data such as the chain's latest block number or a list of
//! checkpoints/messages emitted within a certain block range by calling out to
//! a chain-specific library and provider (e.g. ethers::provider). A
//! chain-specific mailbox or inbox should implement one or both of the Indexer
//! traits (CommonIndexer or MailboxIndexer) to provide an common interface which
//! other entities can retrieve this chain-specific info.

use std::fmt::Debug;

use async_trait::async_trait;
use auto_impl::auto_impl;
use eyre::Result;

use crate::{AbacusMessage, InterchainGasPaymentWithMeta, LogMeta};

/// Interface for an indexer.
#[async_trait]
#[auto_impl(Box, Arc)]
pub trait Indexer: Send + Sync + Debug {
    /// Get the chain's latest block number that has reached finality
    async fn get_finalized_block_number(&self) -> Result<u32>;
}

/// Interface for Mailbox contract indexer. Interface for allowing other
/// entities to retrieve chain-specific data from an mailbox.
#[async_trait]
#[auto_impl(Box, Arc)]
pub trait MailboxIndexer: Indexer {
    /// Fetch list of messages between blocks `from` and `to`.
    async fn fetch_sorted_messages(
        &self,
        from: u32,
        to: u32,
    ) -> Result<Vec<(AbacusMessage, LogMeta)>>;
}

/// Interface for InterchainGasPaymaster contract indexer.
#[async_trait]
#[auto_impl(Box, Arc)]
pub trait InterchainGasPaymasterIndexer: Indexer {
    /// Fetch list of gas payments between `from_block` and `to_block`,
    /// inclusive
    async fn fetch_gas_payments(
        &self,
        from_block: u32,
        to_block: u32,
    ) -> Result<Vec<InterchainGasPaymentWithMeta>>;
}
