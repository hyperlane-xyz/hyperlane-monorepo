use async_trait::async_trait;
use ethers::types::U256;
use std::sync::Arc;

use abacus_core::{
    accumulator::merkle::Proof, AbacusMessage, Address, ChainCommunicationError,
    InboxValidatorManager, MultisigSignedCheckpoint, TxCostEstimate, TxOutcome,
};
use eyre::Result;

#[derive(Debug, Clone)]
/// Arc wrapper for InboxValidatorManagerVariants enum
pub struct InboxValidatorManagers(Arc<InboxValidatorManagerVariants>);

impl From<InboxValidatorManagerVariants> for InboxValidatorManagers {
    fn from(inbox_validator_managers: InboxValidatorManagerVariants) -> Self {
        Self(Arc::new(inbox_validator_managers))
    }
}

impl std::ops::Deref for InboxValidatorManagers {
    type Target = Arc<InboxValidatorManagerVariants>;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl std::ops::DerefMut for InboxValidatorManagers {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

/// InboxValidatorManager type
#[derive(Debug)]
pub enum InboxValidatorManagerVariants {
    /// Ethereum InboxValidatorManager contract
    Ethereum(Box<dyn InboxValidatorManager>),
    /// Mock InboxValidatorManager contract
    Mock(Box<dyn InboxValidatorManager>),
    /// Other InboxValidatorManager variant
    Other(Box<dyn InboxValidatorManager>),
}

#[async_trait]
impl InboxValidatorManager for InboxValidatorManagerVariants {
    /// Submit a signed checkpoint for inclusion
    async fn process(
        &self,
        multisig_signed_checkpoint: &MultisigSignedCheckpoint,
        message: &AbacusMessage,
        proof: &Proof,
        tx_gas_limit: Option<U256>,
    ) -> Result<TxOutcome, ChainCommunicationError> {
        match self {
            InboxValidatorManagerVariants::Ethereum(validator_manager) => {
                validator_manager
                    .process(multisig_signed_checkpoint, message, proof, tx_gas_limit)
                    .await
            }
            InboxValidatorManagerVariants::Mock(mock_validator_manager) => {
                mock_validator_manager
                    .process(multisig_signed_checkpoint, message, proof, tx_gas_limit)
                    .await
            }
            InboxValidatorManagerVariants::Other(validator_manager) => {
                validator_manager
                    .process(multisig_signed_checkpoint, message, proof, tx_gas_limit)
                    .await
            }
        }
    }

    async fn process_estimate_costs(
        &self,
        multisig_signed_checkpoint: &MultisigSignedCheckpoint,
        message: &AbacusMessage,
        proof: &Proof,
    ) -> Result<TxCostEstimate> {
        match self {
            InboxValidatorManagerVariants::Ethereum(validator_manager) => {
                validator_manager
                    .process_estimate_costs(multisig_signed_checkpoint, message, proof)
                    .await
            }
            InboxValidatorManagerVariants::Mock(mock_validator_manager) => {
                mock_validator_manager
                    .process_estimate_costs(multisig_signed_checkpoint, message, proof)
                    .await
            }
            InboxValidatorManagerVariants::Other(validator_manager) => {
                validator_manager
                    .process_estimate_costs(multisig_signed_checkpoint, message, proof)
                    .await
            }
        }
    }

    /// Get calldata for a process tx
    fn process_calldata(
        &self,
        multisig_signed_checkpoint: &MultisigSignedCheckpoint,
        message: &AbacusMessage,
        proof: &Proof,
    ) -> Vec<u8> {
        match self {
            InboxValidatorManagerVariants::Ethereum(validator_manager) => {
                validator_manager.process_calldata(multisig_signed_checkpoint, message, proof)
            }
            InboxValidatorManagerVariants::Mock(mock_validator_manager) => {
                mock_validator_manager.process_calldata(multisig_signed_checkpoint, message, proof)
            }
            InboxValidatorManagerVariants::Other(validator_manager) => {
                validator_manager.process_calldata(multisig_signed_checkpoint, message, proof)
            }
        }
    }

    fn contract_address(&self) -> Address {
        match self {
            InboxValidatorManagerVariants::Ethereum(validator_manager) => {
                validator_manager.contract_address()
            }
            InboxValidatorManagerVariants::Mock(validator_manager) => {
                validator_manager.contract_address()
            }
            InboxValidatorManagerVariants::Other(validator_manager) => {
                validator_manager.contract_address()
            }
        }
    }
}
