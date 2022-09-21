use std::fmt::Debug;

use async_trait::async_trait;
use auto_impl::auto_impl;
use ethers::types::U256;
use eyre::Result;

use crate::{
    accumulator::merkle::Proof,
    traits::{ChainCommunicationError, TxOutcome},
    AbacusMessage, Address, MultisigSignedCheckpoint, TxCostEstimate,
};

/// Interface for an InboxValidatorManager
#[async_trait]
#[auto_impl(Box, Arc)]
pub trait InboxValidatorManager: Send + Sync + Debug {
    /// Process a message with a proof against the provided signed checkpoint
    async fn process(
        &self,
        multisig_signed_checkpoint: &MultisigSignedCheckpoint,
        message: &AbacusMessage,
        proof: &Proof,
        tx_gas_limit: Option<U256>,
    ) -> Result<TxOutcome, ChainCommunicationError>;

    /// Estimate transaction costs to process a message.
    async fn process_estimate_costs(
        &self,
        multisig_signed_checkpoint: &MultisigSignedCheckpoint,
        message: &AbacusMessage,
        proof: &Proof,
    ) -> Result<TxCostEstimate>;

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
