use std::fmt::Debug;

use async_trait::async_trait;
use auto_impl::auto_impl;

use crate::{
    traits::TxOutcome, utils::domain_hash, ChainResult, Checkpoint, HyperlaneContract,
    HyperlaneMessage, TxCostEstimate, H256, U256,
};

/// Interface for the Mailbox chain contract. Allows abstraction over different
/// chains
#[async_trait]
#[auto_impl(Box, Arc)]
pub trait Mailbox: HyperlaneContract + Send + Sync + Debug {
    /// Return the domain hash
    fn domain_hash(&self) -> H256 {
        domain_hash(self.address(), self.domain().id())
    }

    /// Gets the current leaf count of the merkle tree
    async fn count(&self) -> ChainResult<u32>;

    /// Fetch the status of a message
    async fn delivered(&self, id: H256) -> ChainResult<bool>;

    /// Get the latest checkpoint.
    async fn latest_checkpoint(&self, lag: Option<u64>) -> ChainResult<Checkpoint>;

    /// Fetch the current default interchain security module value
    async fn default_ism(&self) -> ChainResult<H256>;

    /// Get the latest checkpoint.
    async fn recipient_ism(&self, recipient: H256) -> ChainResult<H256>;

    /// Process a message with a proof against the provided signed checkpoint
    async fn process(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
        tx_gas_limit: Option<U256>,
    ) -> ChainResult<TxOutcome>;

    /// Estimate transaction costs to process a message.
    async fn process_estimate_costs(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
    ) -> ChainResult<TxCostEstimate>;

    /// Get the calldata for a transaction to process a message with a proof
    /// against the provided signed checkpoint
    fn process_calldata(&self, message: &HyperlaneMessage, metadata: &[u8]) -> Vec<u8>;
}
