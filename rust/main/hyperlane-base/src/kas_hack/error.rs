use dymension_kaspa::kas_relayer::deposit::KaspaTxError;
use hyperlane_core::ChainCommunicationError;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum KaspaDepositError {
    #[error("Deposit not final enough: need {needed} confirmations, have {current}")]
    NotFinalError { needed: i64, current: i64 },

    #[error("Processing error: {0}")]
    ProcessingError(String),
}

impl KaspaDepositError {
    pub fn is_retryable(&self) -> bool {
        true
    }

    // Returns suggested retry delay based on missing confirmations.
    // Kaspa produces ~10 blocks/sec, so 0.1 sec per confirmation.
    pub fn retry_delay_hint(&self) -> Option<f64> {
        match self {
            Self::NotFinalError { needed, current } => {
                let missing = needed.saturating_sub(*current);
                Some(missing as f64 * 0.1)
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
