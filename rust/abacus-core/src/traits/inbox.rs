use async_trait::async_trait;
use color_eyre::Result;
use ethers::core::types::H256;

use crate::{
    accumulator::merkle::Proof,
    traits::{AbacusCommon, ChainCommunicationError, TxOutcome},
    AbacusMessage, MessageStatus,
};

/// Interface for on-chain replicas
#[async_trait]
pub trait Inbox: AbacusCommon + Send + Sync + std::fmt::Debug {
    /// Return the replica domain ID
    fn local_domain(&self) -> u32;

    /// Return the domain of the replica's linked home
    async fn remote_domain(&self) -> Result<u32, ChainCommunicationError>;

    /// Dispatch a transaction to prove inclusion of some leaf in the replica.
    async fn prove(&self, proof: &Proof) -> Result<TxOutcome, ChainCommunicationError>;

    /// Trigger processing of a message
    async fn process(&self, message: &AbacusMessage) -> Result<TxOutcome, ChainCommunicationError>;

    /// Prove a leaf in the replica and then process its message
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
}
