// use fuels::client::FuelClient;
// use fuels::prelude::Provider;
pub struct SealevelClient; // FIXME
pub struct Provider; // FIXME
impl Provider {
    fn new(_client: SealevelClient) -> Self {
        unimplemented!()
    }
}

use hyperlane_core::{ChainCommunicationError, ChainResult};

/// Sealevel connection configuration
#[derive(Debug, serde::Deserialize, Clone)]
pub struct ConnectionConf {
    /// Fully qualified string to connect to
    url: String,
}

#[derive(thiserror::Error, Debug)]
#[error(transparent)]
struct SealevelNewConnectionError(#[from] anyhow::Error);

impl From<SealevelNewConnectionError> for ChainCommunicationError {
    fn from(err: SealevelNewConnectionError) -> Self {
        ChainCommunicationError::from_other(err)
    }
}

fn make_client(conf: &ConnectionConf) -> ChainResult<SealevelClient> {
    // SealevelClient::new(&conf.url).map_err(|e| SealevelNewConnectionError(e).into())
    todo!()
}

/// Create a new fuel provider and connection
pub fn make_provider(conf: &ConnectionConf) -> ChainResult<Provider> {
    Ok(Provider::new(make_client(conf)?))
}
