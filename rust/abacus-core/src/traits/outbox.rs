use std::convert::TryFrom;

use crate::{
    traits::{ChainCommunicationError, TxOutcome},
    AbacusCommon, CommittedMessage, Message, RawCommittedMessage, State,
};
use async_trait::async_trait;
use color_eyre::Result;
use ethers::core::types::H256;

/// Interface for the Outbox chain contract. Allows abstraction over different
/// chains
#[async_trait]
pub trait Outbox: AbacusCommon + Send + Sync + std::fmt::Debug {
    /// Fetch the current state.
    async fn state(&self) -> Result<State, ChainCommunicationError>;

    /// Fetch the nonce
    async fn nonces(&self, destination: u32) -> Result<u32, ChainCommunicationError>;

    /// Dispatch a message.
    async fn dispatch(&self, message: &Message) -> Result<TxOutcome, ChainCommunicationError>;
}

/// Interface for retrieving event data emitted specifically by the outbox
#[async_trait]
pub trait OutboxEvents: Outbox + Send + Sync + std::fmt::Debug {
    /// Fetch the message to destination at the nonce (or error).
    /// This should fetch events from the chain API.
    ///
    /// Used by processors to get messages in order
    async fn raw_message_by_nonce(
        &self,
        destination: u32,
        nonce: u32,
    ) -> Result<Option<RawCommittedMessage>, ChainCommunicationError>;

    /// Fetch the message to destination at the nonce (or error).
    /// This should fetch events from the chain API
    async fn message_by_nonce(
        &self,
        destination: u32,
        nonce: u32,
    ) -> Result<Option<CommittedMessage>, ChainCommunicationError> {
        self.raw_message_by_nonce(destination, nonce)
            .await?
            .map(CommittedMessage::try_from)
            .transpose()
            .map_err(Into::into)
    }

    /// Look up a message by its hash.
    /// This should fetch events from the chain API
    async fn raw_message_by_leaf(
        &self,
        leaf: H256,
    ) -> Result<Option<RawCommittedMessage>, ChainCommunicationError>;

    /// Look up a message by its hash.
    /// This should fetch events from the chain API
    async fn message_by_leaf(
        &self,
        leaf: H256,
    ) -> Result<Option<CommittedMessage>, ChainCommunicationError> {
        self.raw_message_by_leaf(leaf)
            .await?
            .map(CommittedMessage::try_from)
            .transpose()
            .map_err(Into::into)
    }

    /// Fetch the tree_index-th leaf inserted into the merkle tree.
    /// Returns `Ok(None)` if no leaf exists for given `tree_size` (`Ok(None)`
    /// serves as the return value for an index error). If tree_index == 0,
    /// this will return the first inserted leaf.  This is because the Home
    /// emits the index at which the leaf was inserted in (`tree.count() - 1`),
    /// thus the first inserted leaf has an index of 0.
    async fn leaf_by_tree_index(
        &self,
        tree_index: usize,
    ) -> Result<Option<H256>, ChainCommunicationError>;
}
