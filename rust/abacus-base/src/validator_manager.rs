use async_trait::async_trait;

use abacus_core::{
    ChainCommunicationError, InboxValidatorManager, MultisigSignedCheckpoint, TxOutcome,
};

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
    async fn submit_checkpoint(
        &self,
        multisig_signed_checkpoint: &MultisigSignedCheckpoint,
    ) -> Result<TxOutcome, ChainCommunicationError> {
        match self {
            InboxValidatorManagerVariants::Ethereum(validator_manager) => {
                validator_manager
                    .submit_checkpoint(multisig_signed_checkpoint)
                    .await
            }
            InboxValidatorManagerVariants::Mock(mock_validator_manager) => {
                mock_validator_manager
                    .submit_checkpoint(multisig_signed_checkpoint)
                    .await
            }
            InboxValidatorManagerVariants::Other(validator_manager) => {
                validator_manager
                    .submit_checkpoint(multisig_signed_checkpoint)
                    .await
            }
        }
    }
}
