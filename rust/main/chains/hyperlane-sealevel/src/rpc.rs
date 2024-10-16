use solana_client::nonblocking::rpc_client::RpcClient;
use solana_sdk::commitment_config::CommitmentConfig;

/// Kludge to implement Debug for RpcClient.
pub struct SealevelRpcClient(RpcClient);

impl SealevelRpcClient {
    pub fn new(rpc_endpoint: String, commitment: CommitmentConfig) -> Self {
        Self(RpcClient::new_with_commitment(rpc_endpoint, commitment))
    }
}

impl std::fmt::Debug for SealevelRpcClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RpcClient { ... }")
    }
}

impl std::ops::Deref for SealevelRpcClient {
    type Target = RpcClient;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
