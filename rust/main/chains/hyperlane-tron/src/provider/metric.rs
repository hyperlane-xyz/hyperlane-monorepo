use std::{ops::Deref, time::Instant};

use async_trait::async_trait;
use serde::de::DeserializeOwned;
use url::Url;

use hyperlane_core::ChainResult;
use hyperlane_metric::prometheus_metric::{PrometheusClientMetrics, PrometheusConfig};

use crate::provider::base::TronBaseHttpClient;
use crate::provider::traits::{HttpClient, HttpClientBuilder, TronClient, TronRpcClient};

/// Http Client wrapper that records Prometheus metrics for each request
#[derive(Debug)]
pub struct MetricHttpClient<C: TronClient = TronBaseHttpClient> {
    inner: TronRpcClient<C>,
    metrics: PrometheusClientMetrics,
    metrics_config: PrometheusConfig,
}

impl<C: TronClient> Deref for MetricHttpClient<C> {
    type Target = TronRpcClient<C>;

    fn deref(&self) -> &Self::Target {
        &self.inner
    }
}

impl<C: TronClient> Drop for MetricHttpClient<C> {
    fn drop(&mut self) {
        let chain_name = PrometheusConfig::chain_name(&self.metrics_config.chain);
        self.metrics.decrement_provider_instance(chain_name);
    }
}

impl<C: TronClient> Clone for MetricHttpClient<C> {
    fn clone(&self) -> Self {
        let chain_name = PrometheusConfig::chain_name(&self.metrics_config.chain);
        self.metrics.increment_provider_instance(chain_name);

        Self {
            inner: self.inner.clone(),
            metrics: self.metrics.clone(),
            metrics_config: self.metrics_config.clone(),
        }
    }
}

impl<C: TronClient> MetricHttpClient<C> {
    /// Creates a new MetricHttpClient
    pub fn new<Builder: HttpClientBuilder<Client = C>>(
        url: Url,
        metrics: PrometheusClientMetrics,
        metrics_config: PrometheusConfig,
    ) -> ChainResult<Self> {
        let chain_name = PrometheusConfig::chain_name(&metrics_config.chain);
        metrics.increment_provider_instance(chain_name);

        let base_client = Builder::build(url)?;
        Ok(Self {
            inner: TronRpcClient::new(base_client),
            metrics,
            metrics_config,
        })
    }
}

impl<C: TronClient> MetricHttpClient<C> {
    /// Helper to track metrics for RPC calls
    async fn track_request<T, F, Fut>(&self, path: &str, operation: F) -> ChainResult<T>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = ChainResult<T>>,
    {
        let start = Instant::now();
        let res = operation().await;
        self.metrics
            .increment_metrics(&self.metrics_config, path, start, res.is_ok());
        res
    }
}

#[async_trait]
impl<C: TronClient> HttpClient for MetricHttpClient<C> {
    async fn request_post<T: DeserializeOwned + Send>(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> ChainResult<T> {
        self.track_request(path, || self.inner.request_post(path, body))
            .await
    }
}
