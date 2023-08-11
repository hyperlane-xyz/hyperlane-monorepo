use hyperlane_core::config::{ConfigErrResultExt, ConfigPath, ConfigResult, FromRawConf};

/// Cosmos connection configuration
#[derive(Debug, Clone)]
pub enum ConnectionConf {
    /// Cosmos RPC URL
    RpcUrl { url: String, chain_id: String },
    /// Cosmos GRPC URL
    GrpcUrl { url: String, chain_id: String },
}

/// Raw Cosmos connection configuration used for better deserialization errors.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawConnectionConf {
    /// The type of connection to use
    #[serde(rename = "type")]
    connection_type: Option<String>,
    /// A single url to connect to
    url: Option<String>,
    /// The chain ID
    chain_id: Option<String>,
}

/// An error type when parsing a connection configuration.
#[derive(thiserror::Error, Debug)]
pub enum ConnectionConfError {
    /// Missing `url` for connection configuration
    #[error("Missing `url` for connection configuration")]
    MissingConnectionUrl,
    /// Missing `chainId` for connection configuration
    #[error("Missing `chainId` for connection configuration")]
    MissingChainId,
    /// Invalid `url` for connection configuration
    #[error("Invalid `url` for connection configuration: `{0}` ({1})")]
    InvalidConnectionUrl(String, url::ParseError),
    /// Invalid `url` type
    #[error("Invalid connection type")]
    InvalidConnectionType,
    /// Unsupported `url` type
    #[error("Unsupported connection type: '{0}'")]
    UnsupportedConnectionType(String),
}

impl FromRawConf<'_, RawConnectionConf> for ConnectionConf {
    fn from_config_filtered(
        raw: RawConnectionConf,
        cwp: &ConfigPath,
        _filter: (),
    ) -> ConfigResult<Self> {
        use ConnectionConfError::*;

        // parse the connection relate informations
        let connectiont_type = raw.connection_type.as_deref().unwrap_or("grpc");
        let chain_id = raw
            .chain_id
            .ok_or(MissingChainId)
            .into_config_result(|| cwp.join("chainId"))?;
        let url = raw
            .url
            .ok_or(MissingConnectionUrl)
            .into_config_result(|| cwp.join("url"))?;

        match connectiont_type {
            "grpc" => Ok(ConnectionConf::GrpcUrl { url, chain_id }),
            "rpc" => Ok(ConnectionConf::RpcUrl { url, chain_id }),
            t => Err(ConnectionConfError::UnsupportedConnectionType(
                t.to_string(),
            ))
            .into_config_result(|| cwp.join("type")),
        }
    }
}

impl ConnectionConf {
    /// Get the GRPC url
    pub fn get_grpc_url(&self) -> Result<String, ConnectionConfError> {
        if let ConnectionConf::GrpcUrl { url, .. } = self {
            Ok(url.clone())
        } else {
            Err(ConnectionConfError::InvalidConnectionType)
        }
    }

    /// Get the RPC url
    pub fn get_rpc_url(&self) -> Result<String, ConnectionConfError> {
        if let ConnectionConf::RpcUrl { url, .. } = self {
            Ok(url.clone())
        } else {
            Err(ConnectionConfError::InvalidConnectionType)
        }
    }

    pub fn get_chain_id(&self) -> String {
        match self {
            ConnectionConf::GrpcUrl { chain_id, .. } => chain_id.clone(),
            ConnectionConf::RpcUrl { chain_id, .. } => chain_id.clone(),
        }
    }
}
