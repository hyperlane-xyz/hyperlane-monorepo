use std::time::Instant;

use async_trait::async_trait;
use snarkvm_console_account::DeserializeOwned;
use url::Url;

use hyperlane_core::ChainResult;
use hyperlane_metric::prometheus_metric::{PrometheusClientMetrics, PrometheusConfig};

use crate::provider::{BaseHttpClient, HttpClient, RpcClient};

/// Fallback Http Client that tries multiple RpcClients in order
#[derive(Debug)]
pub struct MetricHttpClient {
    inner: RpcClient<BaseHttpClient>,
    metrics: PrometheusClientMetrics,
    metrics_config: PrometheusConfig,
}

impl Drop for MetricHttpClient {
    fn drop(&mut self) {
        // decrement provider metric count
        let chain_name = PrometheusConfig::chain_name(&self.metrics_config.chain);
        self.metrics.decrement_provider_instance(chain_name);
    }
}

impl Clone for MetricHttpClient {
    fn clone(&self) -> Self {
        // increment provider metric count
        let chain_name = PrometheusConfig::chain_name(&self.metrics_config.chain);
        self.metrics.increment_provider_instance(chain_name);

        Self {
            inner: self.inner.clone(),
            metrics: self.metrics.clone(),
            metrics_config: self.metrics_config.clone(),
        }
    }
}

impl MetricHttpClient {
    /// Creates a new FallbackHttpClient from a list of base urls
    pub fn new(
        url: Url,
        metrics: PrometheusClientMetrics,
        metrics_config: PrometheusConfig,
    ) -> ChainResult<Self> {
        // increment provider metric count
        let chain_name = PrometheusConfig::chain_name(&metrics_config.chain);
        metrics.increment_provider_instance(chain_name);

        let base_client = BaseHttpClient::new(url)?;
        Ok(Self {
            inner: RpcClient::new(base_client),
            metrics,
            metrics_config,
        })
    }
}

#[async_trait]
impl HttpClient for MetricHttpClient {
    /// Makes a GET request to the API
    async fn request<T: DeserializeOwned + Send>(
        &self,
        path: &str,
        query: impl Into<Option<serde_json::Value>> + Send,
    ) -> ChainResult<T> {
        let start = Instant::now();
        let res = self.inner.request(path, query).await;
        self.metrics
            .increment_metrics(&self.metrics_config, path, start, res.is_ok());
        res
    }

    /// Makes a POST request to the API
    async fn request_post<T: DeserializeOwned + Send>(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> ChainResult<T> {
        let start = Instant::now();
        let res = self.inner.request_post(path, body).await;
        self.metrics
            .increment_metrics(&self.metrics_config, path, start, res.is_ok());
        res
    }
}
