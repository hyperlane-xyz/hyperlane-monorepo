use sui_sdk::{SuiClientBuilder, SuiClient};
use std::str::FromStr;
use url::Url;

/// Sui RPC client
pub struct SuiRpcClient(SuiClient);
impl SuiRpcClient {
    /// Create a new aptos rpc client from node url
    pub async fn new(rpc_endpoint: String) -> Result<Self, anyhow::Error> {
      let client = SuiClientBuilder::default()
        .build(Url::from_str(&rpc_endpoint).unwrap())
        .await?;
      Ok(Self(client))
    }
}

impl std::ops::Deref for SuiRpcClient {
    type Target = Client;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl std::fmt::Debug for SuiRpcClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SuiRpcClient { ... }")
    }
}
