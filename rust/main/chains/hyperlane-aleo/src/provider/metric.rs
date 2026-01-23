use std::{ops::Deref, time::Instant};

use async_trait::async_trait;
use snarkvm_console_account::DeserializeOwned;
use url::Url;

use hyperlane_core::ChainResult;
use hyperlane_metric::prometheus_metric::{PrometheusClientMetrics, PrometheusConfig};

use crate::provider::{AleoClient, BaseHttpClient, HttpClient, HttpClientBuilder, RpcClient};

/// Fallback Http Client that tries multiple RpcClients in order
#[derive(Debug)]
pub struct MetricHttpClient<C: AleoClient = BaseHttpClient> {
    inner: RpcClient<C>,
    metrics: PrometheusClientMetrics,
    metrics_config: PrometheusConfig,
}

impl<C: AleoClient> Deref for MetricHttpClient<C> {
    type Target = RpcClient<C>;

    fn deref(&self) -> &Self::Target {
        &self.inner
    }
}

impl<C: AleoClient> Drop for MetricHttpClient<C> {
    fn drop(&mut self) {
        // decrement provider metric count
        let chain_name = PrometheusConfig::chain_name(&self.metrics_config.chain);
        self.metrics.decrement_provider_instance(chain_name);
    }
}

impl<C: AleoClient> Clone for MetricHttpClient<C> {
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

impl<C: AleoClient> MetricHttpClient<C> {
    /// Creates a new MetricHttpClient
    pub fn new<Builder: HttpClientBuilder<Client = C>>(
        url: Url,
        metrics: PrometheusClientMetrics,
        metrics_config: PrometheusConfig,
        network: u16,
    ) -> ChainResult<Self> {
        // increment provider metric count
        let chain_name = PrometheusConfig::chain_name(&metrics_config.chain);
        metrics.increment_provider_instance(chain_name);

        let base_client = Builder::build(url, network)?;
        Ok(Self {
            inner: RpcClient::new(base_client),
            metrics,
            metrics_config,
        })
    }
}

#[async_trait]
impl<C: AleoClient> HttpClient for MetricHttpClient<C> {
    /// Makes a GET request to the API
    async fn request<T: DeserializeOwned + Send>(
        &self,
        path: &str,
        query: impl Into<Option<serde_json::Value>> + Send,
    ) -> ChainResult<T> {
        let start = Instant::now();
        let res = self.inner.request(path, query).await;
        let method = path.split('/').next().unwrap_or_default();
        self.metrics
            .increment_metrics(&self.metrics_config, method, start, res.is_ok());
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
        let method = path.split('/').next().unwrap_or_default();
        self.metrics
            .increment_metrics(&self.metrics_config, method, start, res.is_ok());
        res
    }
}
