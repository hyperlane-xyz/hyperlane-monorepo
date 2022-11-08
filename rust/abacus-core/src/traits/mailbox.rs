use std::fmt::Debug;

use async_trait::async_trait;
use auto_impl::auto_impl;
use ethers::{core::types::H256, types::U256};
use eyre::Result;

use crate::{
    traits::{ChainCommunicationError, TxOutcome},
    utils::domain_hash,
    AbacusContract, AbacusMessage, Checkpoint, RawAbacusMessage, TxCostEstimate,
};

/// Interface for the Mailbox chain contract. Allows abstraction over different
/// chains
#[async_trait]
#[auto_impl(Box, Arc)]
pub trait Mailbox: AbacusContract + Send + Sync + Debug {
    /// Return the domain ID
    fn local_domain(&self) -> u32;

    /// Return the domain hash
    fn local_domain_hash(&self) -> H256 {
        domain_hash(self.address(), self.local_domain())
    }

    /// Gets the current leaf count of the merkle tree
    async fn count(&self) -> Result<u32, ChainCommunicationError>;

    /// Fetch the status of a message
    async fn delivered(&self, id: H256) -> Result<bool, ChainCommunicationError>;

    /// Get the latest checkpoint.
    async fn latest_checkpoint(
        &self,
        lag: Option<u64>,
    ) -> Result<Checkpoint, ChainCommunicationError>;

    /// Get the status of a transaction.
    async fn status(&self, txid: H256) -> Result<Option<TxOutcome>, ChainCommunicationError>;

    /// Fetch the current default interchain security module value
    async fn default_module(&self) -> Result<H256, ChainCommunicationError>;

    /// Process a message with a proof against the provided signed checkpoint
    async fn process(
        &self,
        message: &AbacusMessage,
        metadata: &Vec<u8>,
        tx_gas_limit: Option<U256>,
    ) -> Result<TxOutcome, ChainCommunicationError>;

    /// Estimate transaction costs to process a message.
    async fn process_estimate_costs(
        &self,
        message: &AbacusMessage,
        metadata: &Vec<u8>,
    ) -> Result<TxCostEstimate>;

    /// Get the calldata for a transaction to process a message with a proof
    /// against the provided signed checkpoint
    fn process_calldata(&self, message: &AbacusMessage, metadata: &Vec<u8>) -> Vec<u8>;
}

/// Interface for retrieving event data emitted specifically by the outbox
#[async_trait]
#[auto_impl(Box, Arc)]
pub trait MailboxEvents: Mailbox + Send + Sync + Debug {
    /// Look up a message by its id.
    /// This should fetch events from the chain API
    async fn raw_message_by_id(
        &self,
        id: H256,
    ) -> Result<Option<RawAbacusMessage>, ChainCommunicationError>;

    /// Look up a message by its hash.
    /// This should fetch events from the chain API
    /*
    async fn message_by_id(
        &self,
        leaf: H256,
    ) -> Result<Option<AbacusMessage>, ChainCommunicationError> {
        self.raw_message_by_id(leaf)
            .await?
            .map(AbacusMessage::from)
            .transpose()
            .map_err(Into::into)
    }
    */

    /// Fetch the tree_index-th leaf inserted into the merkle tree.
    /// Returns `Ok(None)` if no leaf exists for given `tree_size` (`Ok(None)`
    /// serves as the return value for an index error). If tree_index == 0,
    /// this will return the first inserted leaf.  This is because the Mailbox
    /// emits the index at which the leaf was inserted in (`tree.count() - 1`),
    /// thus the first inserted leaf has an index of 0.
    async fn id_by_nonce(&self, nonce: usize) -> Result<Option<H256>, ChainCommunicationError>;
}
