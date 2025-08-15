use hyperlane_core::ChainCommunicationError;
use thiserror::Error;

/// Kaspa-specific deposit operation errors
#[derive(Error, Debug)]
pub enum KaspaDepositError {
    #[error("Deposit not final enough: need {needed} confirmations, have {current}")]
    NotFinalEnough { needed: u32, current: u32 },

    #[error("Transaction rejected by chain")]
    TransactionRejected,

    #[error("Failed to build deposit FXG: {0}")]
    ProcessingError(String),

    #[error("Message already delivered")]
    AlreadyDelivered,

    #[error("Failed to check delivery status: {0}")]
    DeliveryCheckError(String),

    #[error("Failed to get validator signatures: {0}")]
    ValidatorError(String),
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
                // Calculate delay based on missing confirmations
                let missing = needed.saturating_sub(*current);
                Some(missing as f64 * 1.0) // ~1 second per confirmation
            }
            _ => None,
        }
    }
}

impl From<KaspaDepositError> for ChainCommunicationError {
    fn from(err: KaspaDepositError) -> Self {
        ChainCommunicationError::CustomError(err.to_string())
    }
}
