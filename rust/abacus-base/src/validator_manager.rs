use async_trait::async_trait;
use std::sync::Arc;

use abacus_core::{
    ChainCommunicationError, InboxValidatorManager, MultisigSignedCheckpoint, TxOutcome,
};

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
