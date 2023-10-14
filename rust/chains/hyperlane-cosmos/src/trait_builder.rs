use hyperlane_core::config::{ConfigErrResultExt, ConfigPath, ConfigResult, FromRawConf};

/// Cosmos connection configuration
#[derive(Debug, Clone)]
pub struct ConnectionConf {
    /// The GRPC url to connect to
    grpc_url: String,
    /// The RPC url to connect to
    rpc_url: String,
    /// The chain ID
    chain_id: String,
    /// The prefix for the account address
    prefix: String,
}

/// Raw Cosmos connection configuration used for better deserialization errors.
#[derive(Debug, serde::Deserialize)]
pub struct RawConnectionConf {
    /// A single url to connect to rpc
    rpc_url: Option<String>,
    /// A single url to connect to grpc
    grpc_url: Option<String>,
    /// The chain ID
    chain_id: Option<String>,
    /// chain prefix
    prefix: Option<String>,
}

/// An error type when parsing a connection configuration.
#[derive(thiserror::Error, Debug)]
pub enum ConnectionConfError {
    /// Missing `rpc_url` for connection configuration
    #[error("Missing `rpc_url` for connection configuration")]
    MissingConnectionRpcUrl,
    /// Missing `grpc_url` for connection configuration
    #[error("Missing `grpc_url` for connection configuration")]
    MissingConnectionGrpcUrl,
    /// Missing `chainId` for connection configuration
    #[error("Missing `chainId` for connection configuration")]
    MissingChainId,
    /// Missing `prefix` for connection configuration
    #[error("Missing `prefix` for connection configuration")]
    MissingPrefix,
    /// Invalid `url` for connection configuration
    #[error("Invalid `url` for connection configuration: `{0}` ({1})")]
    InvalidConnectionUrl(String, url::ParseError),
}

impl FromRawConf<RawConnectionConf> for ConnectionConf {
    fn from_config_filtered(
        raw: RawConnectionConf,
        cwp: &ConfigPath,
        _filter: (),
    ) -> ConfigResult<Self> {
        use ConnectionConfError::*;

        // parse the connection relate informations
        let chain_id = raw
            .chain_id
            .ok_or(MissingChainId)
            .into_config_result(|| cwp.join("chainId"))?;
        let rpc_url = raw
            .rpc_url
            .ok_or(MissingConnectionRpcUrl)
            .into_config_result(|| cwp.join("rpc_url"))?;
        let grpc_url = raw
            .grpc_url
            .ok_or(MissingConnectionGrpcUrl)
            .into_config_result(|| cwp.join("grpc_url"))?;
        let prefix = raw
            .prefix
            .ok_or(MissingPrefix)
            .into_config_result(|| cwp.join("prefix"))?;

        Ok(ConnectionConf {
            grpc_url,
            rpc_url,
            chain_id,
            prefix,
        })
    }
}

impl ConnectionConf {
    /// Get the GRPC url
    pub fn get_grpc_url(&self) -> String {
        self.grpc_url.clone()
    }

    /// Get the RPC url
    pub fn get_rpc_url(&self) -> String {
        self.rpc_url.clone()
    }

    /// Get the chain ID
    pub fn get_chain_id(&self) -> String {
        self.chain_id.clone()
    }

    /// Get the prefix
    pub fn get_prefix(&self) -> String {
        self.prefix.clone()
    }
}
