use fuels::client::FuelClient;
use fuels::prelude::Provider;

use hyperlane_core::{ChainCommunicationError, ChainResult};

/// Fuel connection configuration
#[derive(Debug, serde::Deserialize, Clone)]
pub struct ConnectionConf {
    /// Fully qualified string to connect to
    url: String,
}

#[derive(thiserror::Error, Debug)]
#[error(transparent)]
struct FuelNewConnectionError(#[from] anyhow::Error);

impl From<FuelNewConnectionError> for ChainCommunicationError {
    fn from(err: FuelNewConnectionError) -> Self {
        ChainCommunicationError::from_other(err)
    }
}

fn make_client(conf: &ConnectionConf) -> ChainResult<FuelClient> {
    FuelClient::new(&conf.url).map_err(|e| FuelNewConnectionError(e).into())
}

pub fn make_provider(conf: &ConnectionConf) -> ChainResult<Provider> {
    Ok(Provider::new(make_client(conf)?))
}
