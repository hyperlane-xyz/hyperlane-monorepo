use hyperlane_core::ChainCommunicationError;
use url::Url;

/// Starknet connection configuration
#[derive(Debug, Clone)]
pub struct ConnectionConf {
    /// Fully qualified string to connect to
    pub url: Url,
}

/// An error type when parsing a connection configuration.
#[derive(thiserror::Error, Debug)]
pub enum ConnectionConfError {
    /// Missing `url` for connection configuration
    #[error("Missing `url` for connection configuration")]
    MissingConnectionUrl,
    /// Invalid `url` for connection configuration
    #[error("Invalid `url` for connection configuration: `{0}` ({1})")]
    InvalidConnectionUrl(String, url::ParseError),
}

#[derive(thiserror::Error, Debug)]
#[error(transparent)]
struct StarknetNewConnectionError(#[from] anyhow::Error);

impl From<StarknetNewConnectionError> for ChainCommunicationError {
    fn from(err: StarknetNewConnectionError) -> Self {
        ChainCommunicationError::from_other(err)
    }
}
