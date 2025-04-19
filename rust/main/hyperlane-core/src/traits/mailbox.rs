use std::fmt::Debug;

use async_trait::async_trait;
use derive_new::new;

use crate::{
    traits::TxOutcome, utils::domain_hash, ChainCommunicationError, ChainResult, HyperlaneContract,
    HyperlaneMessage, QueueOperation, ReorgPeriod, TxCostEstimate, H256, U256,
};

/// Interface for the Mailbox chain contract. Allows abstraction over different
/// chains
#[async_trait]
pub trait Mailbox: HyperlaneContract + Send + Sync + Debug {
    /// Return the domain hash
    fn domain_hash(&self) -> H256 {
        domain_hash(self.address(), self.domain().id())
    }

    /// Gets the current leaf count of the merkle tree
    ///
    /// - `reorg_period` is how far behind the current block to query, if not specified
    ///   it will query at the latest block.
    async fn count(&self, reorg_period: &ReorgPeriod) -> ChainResult<u32>;

    /// Fetch the status of a message
    async fn delivered(&self, id: H256) -> ChainResult<bool>;

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

    /// True if the destination chain supports batching
    /// (i.e. if the mailbox contract will succeed on a `process_batch` call)
    fn supports_batching(&self) -> bool {
        // Default to false
        false
    }

    /// Try process the given operations as a batch. Returns the outcome of the
    /// batch (if one was submitted) and the operations that were not submitted.
    async fn process_batch<'a>(&self, _ops: Vec<&'a QueueOperation>) -> ChainResult<BatchResult> {
        // Batching is not supported by default
        Err(ChainCommunicationError::BatchingFailed)
    }

    /// Estimate transaction costs to process a message.
    /// Arguments:
    /// - `message`: The message to be processed
    /// - `metadata`: The metadata needed to process the message
    async fn process_estimate_costs(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
    ) -> ChainResult<TxCostEstimate>;

    /// Get the calldata for a transaction to process a message with a proof
    /// against the provided signed checkpoint
    async fn process_calldata(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
    ) -> ChainResult<Vec<u8>>;
}

/// The result of processing a batch of messages
#[derive(new, Debug)]
pub struct BatchResult {
    /// The outcome of executing the batch, if one was sent
    pub outcome: Option<TxOutcome>,
    /// Indexes of excluded calls from the batch (i.e. that were not executed)
    pub failed_indexes: Vec<usize>,
}

impl BatchResult {
    /// Create a BatchResult from a failed simulation, given the number of operations
    /// in the simulated batch
    pub fn failed(ops_count: usize) -> Self {
        Self {
            outcome: None,
            failed_indexes: (0..ops_count).collect(),
        }
    }
}
