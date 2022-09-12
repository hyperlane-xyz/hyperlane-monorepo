use std::convert::TryFrom;
use std::fmt::Debug;

use async_trait::async_trait;
use auto_impl::auto_impl;
use ethers::core::types::H256;
use eyre::Result;

use crate::{
    traits::{ChainCommunicationError, TxOutcome},
    AbacusCommon, Checkpoint, CommittedMessage, Message, OutboxState, RawCommittedMessage,
};

/// Interface for the Outbox chain contract. Allows abstraction over different
/// chains
#[async_trait]
#[auto_impl(Box, Arc)]
pub trait Outbox: AbacusCommon + Send + Sync + Debug {
    /// Fetch the current state.
    async fn state(&self) -> Result<OutboxState, ChainCommunicationError>;

    /// Gets the current leaf count of the merkle tree
    async fn count(&self) -> Result<u32, ChainCommunicationError>;

    /// Dispatch a message.
    async fn dispatch(&self, message: &Message) -> Result<TxOutcome, ChainCommunicationError>;

    /// Caches the latest checkpoint.
    async fn cache_checkpoint(&self) -> Result<TxOutcome, ChainCommunicationError>;

    /// Fetch the latest cached root.
    async fn latest_cached_root(&self) -> Result<H256, ChainCommunicationError>;

    /// Return the latest cached checkpoint.
    async fn latest_cached_checkpoint(&self) -> Result<Checkpoint, ChainCommunicationError>;

    /// Get the latest checkpoint.
    async fn latest_checkpoint(
        &self,
        lag: Option<u64>,
    ) -> Result<Checkpoint, ChainCommunicationError>;

    /// Calls checkpoint on mock variant. Should only be used during tests.
    #[auto_impl(keep_default_for(Box, Arc))]
    fn checkpoint(&mut self) {
        unimplemented!("Checkpoint is only available for mock implementations of outbox.")
    }
}

/// Interface for retrieving event data emitted specifically by the outbox
#[async_trait]
#[auto_impl(Box, Arc)]
pub trait OutboxEvents: Outbox + Send + Sync + Debug {
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
    /// this will return the first inserted leaf.  This is because the Outbox
    /// emits the index at which the leaf was inserted in (`tree.count() - 1`),
    /// thus the first inserted leaf has an index of 0.
    async fn leaf_by_tree_index(
        &self,
        tree_index: usize,
    ) -> Result<Option<H256>, ChainCommunicationError>;
}
