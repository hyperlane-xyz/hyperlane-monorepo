use fuels::{client::FuelClient, prelude::Provider};
use hyperlane_core::{config::*, ChainCommunicationError, ChainResult};
use url::Url;

/// Fuel connection configuration
#[derive(Debug, Clone)]
pub struct ConnectionConf {
    /// Fully qualified string to connect to
    pub url: Url,
}

/// Raw fuel connection configuration used for better deserialization errors.
#[derive(Debug, serde::Deserialize)]
pub struct DeprecatedRawConnectionConf {
    url: Option<String>,
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

impl FromRawConf<DeprecatedRawConnectionConf> for ConnectionConf {
    fn from_config_filtered(
        raw: DeprecatedRawConnectionConf,
        cwp: &ConfigPath,
        _filter: (),
    ) -> ConfigResult<Self> {
        use ConnectionConfError::*;
        match raw {
            DeprecatedRawConnectionConf { url: Some(url) } => Ok(Self {
                url: url
                    .parse()
                    .map_err(|e| InvalidConnectionUrl(url, e))
                    .into_config_result(|| cwp.join("url"))?,
            }),
            DeprecatedRawConnectionConf { url: None } => {
                Err(MissingConnectionUrl).into_config_result(|| cwp.join("url"))
            }
        }
    }
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

/// Create a new fuel provider and connection
pub fn make_provider(conf: &ConnectionConf) -> ChainResult<Provider> {
    Ok(Provider::new(make_client(conf)?))
}
