use solana_client::nonblocking::rpc_client::RpcClient;
use solana_sdk::commitment_config::CommitmentConfig;

/// Kludge to implement Debug for RpcClient.
pub struct RpcClientWithDebug(RpcClient);

impl RpcClientWithDebug {
    pub fn new(rpc_endpoint: String) -> Self {
        Self(RpcClient::new(rpc_endpoint))
    }

    pub fn new_with_commitment(rpc_endpoint: String, commitment: CommitmentConfig) -> Self {
        Self(RpcClient::new_with_commitment(rpc_endpoint, commitment))
    }
}

impl std::fmt::Debug for RpcClientWithDebug {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RpcClient { ... }")
    }
}

impl std::ops::Deref for RpcClientWithDebug {
    type Target = RpcClient;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
