use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OptionalConnectionClientConfig {
    mailbox: Option<String>,
    interchain_gas_paymaster: Option<String>,
    interchain_security_module: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OptionalOwnableConfig {
    owner: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RouterConfig {
    foreign_deployment: Option<String>,
    #[serde(flatten)]
    ownable: OptionalOwnableConfig,
    #[serde(flatten)]
    connection_client: OptionalConnectionClientConfig,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RpcUrlConfig {
    pub http: String,
}

/// An abridged version of the Typescript ChainMetadata
#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChainMetadata {
    chain_id: u32,
    /// Hyperlane domain, only required if differs from id above
    domain_id: Option<u32>,
    name: String,
    /// Collection of RPC endpoints
    public_rpc_urls: Vec<RpcUrlConfig>,
}
