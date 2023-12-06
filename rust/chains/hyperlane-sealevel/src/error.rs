use hyperlane_core::ChainCommunicationError;
use solana_client::client_error::ClientError;
use solana_sdk::pubkey::ParsePubkeyError;

/// Errors from the crates specific to the hyperlane-sealevel
/// implementation.
/// This error can then be converted into the broader error type
/// in hyperlane-core using the `From` trait impl
#[derive(Debug, thiserror::Error)]
pub enum HyperlaneSealevelError {
    /// ParsePubkeyError error
    #[error("{0}")]
    ParsePubkeyError(#[from] ParsePubkeyError),
    /// ClientError error
    #[error("{0}")]
    ClientError(#[from] ClientError),
}

impl From<HyperlaneSealevelError> for ChainCommunicationError {
    fn from(value: HyperlaneSealevelError) -> Self {
        ChainCommunicationError::from_other(value)
    }
}
