use async_trait::async_trait;

use hyperlane_core::{
    rpc_clients::{BlockNumberGetter, FallbackProvider},
    ChainResult,
};
use hyperlane_metric::prometheus_metric::{
    ClientConnectionType, PrometheusClientMetrics, PrometheusConfig,
};
use snarkvm_console_account::{DeserializeOwned, Itertools};
use url::Url;

use crate::provider::{metric::MetricHttpClient, HttpClient, RpcClient};

/// Fallback Http Client that tries multiple RpcClients in order
#[derive(Clone, Debug)]
pub struct FallbackHttpClient {
    fallback: FallbackProvider<RpcClient<MetricHttpClient>, RpcClient<MetricHttpClient>>,
}

impl FallbackHttpClient {
    /// Creates a new FallbackHttpClient from a list of base urls
    pub fn new(
        urls: Vec<Url>,
        metrics: PrometheusClientMetrics,
        chain: Option<hyperlane_metric::prometheus_metric::ChainInfo>,
    ) -> ChainResult<Self> {
        let clients = urls
            .into_iter()
            .map(|url| {
                let metrics_config =
                    PrometheusConfig::from_url(&url, ClientConnectionType::Rpc, chain.clone());
                MetricHttpClient::new(url, metrics.clone(), metrics_config)
            })
            .collect::<ChainResult<Vec<_>>>()?
            .into_iter()
            .map(RpcClient::new)
            .collect_vec();
        let fallback = FallbackProvider::new(clients);
        Ok(Self { fallback })
    }
}

#[async_trait]
impl<C: HttpClient + std::fmt::Debug + Send + Sync> BlockNumberGetter for RpcClient<C> {
    async fn get_block_number(&self) -> ChainResult<u64> {
        let height = self.get_latest_height().await?;
        Ok(height as u64)
    }
}

#[async_trait]
impl HttpClient for FallbackHttpClient {
    /// Makes a GET request to the API
    async fn request<T: DeserializeOwned + Send>(
        &self,
        path: &str,
        query: impl Into<Option<serde_json::Value>> + Send,
    ) -> ChainResult<T> {
        let query = query.into();
        self.fallback
            .call(|inner| {
                let path = path.to_string();
                let query = query.clone();
                let future = async move { inner.request(&path, query).await };
                Box::pin(future)
            })
            .await
    }

    /// Makes a POST request to the API
    async fn request_post<T: DeserializeOwned + Send>(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> ChainResult<T> {
        self.fallback
            .call(|inner| {
                let path = path.to_string();
                let body = body.clone();
                let future = async move { inner.request_post(&path, &body).await };
                Box::pin(future)
            })
            .await
    }
}
