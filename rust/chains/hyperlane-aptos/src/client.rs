use solana_client::nonblocking::rpc_client::RpcClient;

use aptos_sdk::rest_client::Client;
use url::Url;
use std::str::FromStr;

/// Kludge to implement Debug for RpcClient.
pub(crate) struct RpcClientWithDebug(RpcClient);

impl RpcClientWithDebug {
    pub fn new(rpc_endpoint: String) -> Self {
        Self(RpcClient::new(rpc_endpoint))
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
