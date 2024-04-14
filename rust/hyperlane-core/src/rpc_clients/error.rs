use thiserror::Error;

use crate::ChainCommunicationError;

/// Errors specific to fallback provider.
#[derive(Error, Debug)]
pub enum RpcClientError {
    /// Fallback providers failed
    #[error("All fallback providers failed. (Errors: {0:?})")]
    FallbackProvidersFailed(Vec<ChainCommunicationError>),
}
