use dym_kas_relayer::deposit::KaspaTxError;
use hyperlane_core::ChainCommunicationError;
use thiserror::Error;

/// Extended Kaspa deposit operation errors with additional context
#[derive(Error, Debug)]
pub enum KaspaDepositError {
    #[error("Deposit not final enough: need {needed} confirmations, have {current}")]
    NotFinalError { needed: i64, current: i64 },

    #[error("Processing error: {0}")]
    ProcessingError(String),
}

impl KaspaDepositError {
    /// Check if this error is retryable  
    pub fn is_retryable(&self) -> bool {
        // All errors are retryable in this simplified version
        true
    }

    /// Get retry delay hint in seconds (if applicable)
    pub fn retry_delay_hint(&self) -> Option<f64> {
        match self {
            Self::NotFinalError { needed, current } => {
                let missing = needed.saturating_sub(*current);
                Some(missing as f64 * 0.1) // ~0.1 second per confirmation (10 confirmations per second)
            }
            _ => None,
        }
    }
}

impl From<KaspaTxError> for KaspaDepositError {
    fn from(err: KaspaTxError) -> Self {
        match err {
            KaspaTxError::NotFinalError {
                confirmations,
                required_confirmations,
                ..
            } => KaspaDepositError::NotFinalError {
                needed: required_confirmations,
                current: confirmations,
            },
            KaspaTxError::ProcessingError(e) => KaspaDepositError::ProcessingError(e.to_string()),
        }
    }
}

impl From<KaspaDepositError> for ChainCommunicationError {
    fn from(err: KaspaDepositError) -> Self {
        ChainCommunicationError::CustomError(err.to_string())
    }
}
