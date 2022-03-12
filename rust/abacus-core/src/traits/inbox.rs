use async_trait::async_trait;
use color_eyre::Result;
use ethers::core::types::H256;

use crate::{
    accumulator::merkle::Proof,
    traits::{AbacusCommon, ChainCommunicationError, TxOutcome},
    AbacusMessage, MessageStatus, SignedCheckpoint,
};

/// Interface for on-chain inboxes
#[async_trait]
pub trait Inbox: AbacusCommon + Send + Sync + std::fmt::Debug {
    /// Return the domain of the inbox's linked outbox
    async fn remote_domain(&self) -> Result<u32, ChainCommunicationError>;

    /// Dispatch a transaction to prove inclusion of some leaf in the inbox.
    async fn prove(&self, proof: &Proof) -> Result<TxOutcome, ChainCommunicationError>;

    /// Trigger processing of a message
    async fn process(&self, message: &AbacusMessage) -> Result<TxOutcome, ChainCommunicationError>;

    /// Prove a leaf in the inbox and then process its message
    async fn prove_and_process(
        &self,
        message: &AbacusMessage,
        proof: &Proof,
    ) -> Result<TxOutcome, ChainCommunicationError> {
        self.prove(proof).await?;

        Ok(self.process(message).await?)
    }

    /// Fetch the status of a message
    async fn message_status(&self, leaf: H256) -> Result<MessageStatus, ChainCommunicationError>;

    /// Submit a signed checkpoint for inclusion
    /// Mocks already have a function called checkpoint
    async fn submit_checkpoint(
        &self,
        signed_checkpoint: &SignedCheckpoint,
    ) -> Result<TxOutcome, ChainCommunicationError>;
}
