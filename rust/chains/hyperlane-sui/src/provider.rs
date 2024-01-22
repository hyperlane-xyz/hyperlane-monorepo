use hyperlane_core::HyperlaneDomain;
use anyhow::Error;
use crate::SuiRpcClient;

/// A wrapper around a Sui provider to get generic blockchain information.
#[derive(Debug)]
pub struct SuiHpProvider {
    domain: HyperlaneDomain,
    sui_client: SuiRpcClient,
}

impl SuiHpProvider {
    /// Create a new Sui provider.
    pub async fn new(domain: HyperlaneDomain, rest_url: String) -> Result<Self, Error> {
        let sui_client = SuiRpcClient::new(rest_url).await?;
        Ok(
            Self {
                domain,
                sui_client,
            }
        )
    }
}