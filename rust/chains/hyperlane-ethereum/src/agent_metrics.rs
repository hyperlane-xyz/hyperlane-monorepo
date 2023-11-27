use async_trait::async_trait;
use hyperlane_core::{metrics::agent::AgenMetricsFetcher, ChainResult, U256};

pub struct EthereumMetricsFetcher {}

#[async_trait]
impl AgenMetricsFetcher for EthereumMetricsFetcher {
    async fn get_balance(&self) -> ChainResult<U256> {
        Ok(0.into())
    }
}
