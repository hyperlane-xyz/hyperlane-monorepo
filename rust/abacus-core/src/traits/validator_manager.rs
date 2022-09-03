use std::fmt::Debug;

use async_trait::async_trait;
use eyre::Result;

use crate::{
    accumulator::merkle::Proof,
    traits::{ChainCommunicationError, TxOutcome},
    AbacusMessage, Address, MultisigSignedCheckpoint,
};

/// Interface for an InboxValidatorManager
#[async_trait]
pub trait InboxValidatorManager: Send + Sync + Debug {
    /// Process a message with a proof against the provided signed checkpoint
    async fn process(
        &self,
        multisig_signed_checkpoint: &MultisigSignedCheckpoint,
        message: &AbacusMessage,
        proof: &Proof,
    ) -> Result<TxOutcome, ChainCommunicationError>;

    /// Get the calldata for a transaction to process a message with a proof
    /// against the provided signed checkpoint
    fn process_calldata(
        &self,
        multisig_signed_checkpoint: &MultisigSignedCheckpoint,
        message: &AbacusMessage,
        proof: &Proof,
    ) -> Vec<u8>;

    /// The on-chain address of the inbox validator manager contract.
    fn contract_address(&self) -> Address;
}
