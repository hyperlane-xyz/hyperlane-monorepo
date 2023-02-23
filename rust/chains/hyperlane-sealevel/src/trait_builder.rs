// FIXME is this really needed?
pub struct SealevelClient;
pub struct Provider;
impl Provider {
    fn new(_client: SealevelClient) -> Self {
        todo!() // FIXME
    }
}

use hyperlane_core::{ChainCommunicationError, ChainResult};

/// Sealevel connection configuration
#[derive(Debug, serde::Deserialize, Clone)]
pub struct ConnectionConf {
    /// Fully qualified string to connect to
    pub url: String,
}

#[derive(thiserror::Error, Debug)]
#[error(transparent)]
struct SealevelNewConnectionError(#[from] anyhow::Error);

impl From<SealevelNewConnectionError> for ChainCommunicationError {
    fn from(err: SealevelNewConnectionError) -> Self {
        ChainCommunicationError::from_other(err)
    }
}

fn make_client(_conf: &ConnectionConf) -> ChainResult<SealevelClient> {
    // SealevelClient::new(&conf.url).map_err(|e| SealevelNewConnectionError(e).into())
    todo!() // FIXME
}

/// Create a new fuel provider and connection
pub fn make_provider(conf: &ConnectionConf) -> ChainResult<Provider> {
    Ok(Provider::new(make_client(conf)?))
}
