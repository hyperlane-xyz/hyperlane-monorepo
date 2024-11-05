use fuels::{client::FuelClient, prelude::Provider};
use hyperlane_core::{config::OperationBatchConfig, ChainCommunicationError, ChainResult};
use url::Url;

/// Fuel connection configuration
#[derive(Debug, Clone)]
pub struct ConnectionConf {
    /// Fully qualified string to connect to
    pub url: Url,
    /// Config for batching messages
    pub operation_batch: OperationBatchConfig,
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
struct FuelNewConnectionError(#[from] anyhow::Error);

impl From<FuelNewConnectionError> for ChainCommunicationError {
    fn from(err: FuelNewConnectionError) -> Self {
        ChainCommunicationError::from_other(err)
    }
}

/// Create a new Fuel client
pub fn make_client(conf: &ConnectionConf) -> ChainResult<FuelClient> {
    FuelClient::new(&conf.url).map_err(|e| FuelNewConnectionError(e).into())
}

/// Create a new fuel provider and connection
pub async fn make_provider(conf: &ConnectionConf) -> ChainResult<Provider> {
    Provider::connect(&conf.url)
        .await
        .map_err(|e| FuelNewConnectionError(e.into()).into())
}
