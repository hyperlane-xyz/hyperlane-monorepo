use aptos_sdk::rest_client::Client;
use std::str::FromStr;
use url::Url;

/// Aptos RPC client
pub struct AptosClient(Client);
impl AptosClient {
    /// Create a new aptos rpc client from node url
    pub fn new(rpc_endpoint: String) -> Self {
        Self(Client::new(Url::from_str(&rpc_endpoint).unwrap()))
    }
}

impl std::ops::Deref for AptosClient {
    type Target = Client;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl std::fmt::Debug for AptosClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("AptosClient { ... }")
    }
}
