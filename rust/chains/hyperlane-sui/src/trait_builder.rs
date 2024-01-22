use url::Url;

use hyperlane_core::{
    config::{ConfigErrResultExt, ConfigResult, FromRawConf},
    ChainCommunicationError,
};
/// Sui connection configuration 

#[derive(Debug, Clone)]
pub struct ConnectionConf {
    /// Fully qualified string to connect to
    pub url: Url,
}

// Raw Sui connection configration used for better deserialization errors.
#[derive(Debug, Clone)]
pub struct DeprecatedRawConnectionConf {
    url: Option<String>,
}

#[derive(Debug, Clone)]
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
struct AptosNewConnectionError(#[from] anyhow::Error);