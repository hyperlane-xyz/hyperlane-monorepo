use std::fmt::Debug;

use async_trait::async_trait;
use auto_impl::auto_impl;
use ethers::{core::types::H256, types::U256};
use eyre::Result;

use crate::{
    traits::{ChainCommunicationError, TxOutcome},
    utils::domain_hash,
    AbacusContract, AbacusMessage, Checkpoint, TxCostEstimate,
};

/// Interface for the Mailbox chain contract. Allows abstraction over different
/// chains
#[async_trait]
#[auto_impl(Box, Arc)]
pub trait Mailbox: AbacusContract + Send + Sync + Debug {
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

    /// Fetch the current default interchain security module value
    async fn default_ism(&self) -> Result<H256, ChainCommunicationError>;

    /// Process a message with a proof against the provided signed checkpoint
    async fn process(
        &self,
        message: &AbacusMessage,
        metadata: &[u8],
        tx_gas_limit: Option<U256>,
    ) -> Result<TxOutcome, ChainCommunicationError>;

    /// Estimate transaction costs to process a message.
    async fn process_estimate_costs(
        &self,
        message: &AbacusMessage,
        metadata: &[u8],
    ) -> Result<TxCostEstimate>;

    /// Get the calldata for a transaction to process a message with a proof
    /// against the provided signed checkpoint
    fn process_calldata(&self, message: &AbacusMessage, metadata: &[u8]) -> Vec<u8>;
}
