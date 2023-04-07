//! An Indexer provides a common interface for bubbling up chain-specific
//! event-data to another entity (e.g. a `ContractSync`). For example, the only
//! way to retrieve data such as the chain's latest block number or a list of
//! checkpoints/messages emitted within a certain block range by calling out to
//! a chain-specific library and provider (e.g. ethers::provider).

use std::fmt::Debug;

use async_trait::async_trait;
use auto_impl::auto_impl;

use crate::{ChainResult, HyperlaneMessage, InterchainGasPayment, LogMeta, H256};

/// Interface for an indexer.
#[async_trait]
#[auto_impl(&, Box, Arc)]
pub trait Indexer: Send + Sync + Debug {
    /// Get the chain's latest block number that has reached finality
    async fn get_finalized_block_number(&self) -> ChainResult<u32>;
}

/// Interface for Mailbox contract indexer. Interface for allowing other
/// entities to retrieve chain-specific data from a mailbox.
#[async_trait]
#[auto_impl(&, Box, Arc)]
pub trait MailboxIndexer: Indexer {
    /// Fetch list of outbound messages between blocks `from` and `to`, sorted
    /// by nonce.
    async fn fetch_sorted_messages(
        &self,
        from: u32,
        to: u32,
    ) -> ChainResult<Vec<(HyperlaneMessage, LogMeta)>>;

    /// Fetch a list of delivered message IDs between blocks `from` and `to`.
    async fn fetch_delivered_messages(
        &self,
        from: u32,
        to: u32,
    ) -> ChainResult<Vec<(H256, LogMeta)>>;
}

/// Interface for InterchainGasPaymaster contract indexer.
#[async_trait]
#[auto_impl(&, Box, Arc)]
pub trait InterchainGasPaymasterIndexer: Indexer {
    /// Fetch list of gas payments between `from_block` and `to_block`,
    /// inclusive
    async fn fetch_gas_payments(
        &self,
        from_block: u32,
        to_block: u32,
    ) -> ChainResult<Vec<(InterchainGasPayment, LogMeta)>>;
}
