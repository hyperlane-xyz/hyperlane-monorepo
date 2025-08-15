use dym_kas_relayer::deposit::DepositError;
use hyperlane_core::ChainCommunicationError;
use thiserror::Error;

/// Extended Kaspa deposit operation errors with additional context
#[derive(Error, Debug)]
pub enum KaspaDepositError {
    #[error("Deposit not final enough: need {needed} confirmations, have {current}")]
    NotFinalEnough { needed: i64, current: i64 },

    #[error("Failed to build deposit FXG: {0}")]
    ProcessingError(String),

    #[error("Message already delivered")]
    AlreadyDelivered,

    #[error("Failed to check delivery status: {0}")]
    DeliveryCheckError(String),

    #[error("Failed to get validator signatures: {0}")]
    ValidatorError(String),

    #[error("Transaction rejected by chain")]
    TransactionRejected,
}

impl KaspaDepositError {
    /// Check if this error is retryable
    pub fn is_retryable(&self) -> bool {
        !matches!(self, Self::TransactionRejected | Self::AlreadyDelivered)
    }

    /// Get retry delay hint in seconds (if applicable)
    pub fn retry_delay_hint(&self) -> Option<f64> {
        match self {
            Self::NotFinalEnough { needed, current } => {
                let missing = needed.saturating_sub(*current);
                Some(missing as f64 * 0.1) // ~0.1 second per confirmation (10 confirmations per second)
            }
            _ => None,
        }
    }
}

impl From<DepositError> for KaspaDepositError {
    fn from(err: DepositError) -> Self {
        match err {
            DepositError::NotFinalEnough {
                confirmations,
                required_confirmations,
                ..
            } => KaspaDepositError::NotFinalEnough {
                needed: required_confirmations,
                current: confirmations,
            },
            DepositError::ProcessingError(e) => KaspaDepositError::ProcessingError(e.to_string()),
        }
    }
}

impl From<KaspaDepositError> for ChainCommunicationError {
    fn from(err: KaspaDepositError) -> Self {
        ChainCommunicationError::CustomError(err.to_string())
    }
}
