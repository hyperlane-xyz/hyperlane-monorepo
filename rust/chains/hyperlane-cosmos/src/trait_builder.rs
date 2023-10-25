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
    /// Canoncial Assets Denom
    canonical_asset: String,
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

    /// Get the asset
    pub fn get_canonical_asset(&self) -> String {
        self.canonical_asset.clone()
    }

    /// Create a new connection configuration
    pub fn new(
        grpc_url: String,
        rpc_url: String,
        chain_id: String,
        prefix: String,
        canonical_asset: String,
    ) -> Self {
        Self {
            grpc_url,
            rpc_url,
            chain_id,
            prefix,
            canonical_asset,
        }
    }
}
