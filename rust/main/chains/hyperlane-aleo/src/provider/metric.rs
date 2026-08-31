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
    fn method(path: &str) -> String {
        let mut segments = path.split('/');
        let first = segments.next().unwrap_or_default();
        match (first, segments.next()) {
            ("transaction", Some(action @ ("confirmed" | "unconfirmed" | "broadcast"))) => {
                format!("transaction_{action}")
            }
            _ => first.to_owned(),
        }
    }

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

impl<C: AleoClient> MetricHttpClient<C> {
    /// Helper function to track metrics for RPC calls
    async fn track_request<T, F, Fut>(&self, path: &str, operation: F) -> ChainResult<T>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = ChainResult<T>>,
    {
        let start = Instant::now();
        let res = operation().await;
        let method = Self::method(path);
        self.metrics
            .increment_metrics(&self.metrics_config, &method, start, res.is_ok());
        res
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
        self.track_request(path, || self.inner.request(path, query))
            .await
    }

    async fn request_optional<T: DeserializeOwned + Send>(
        &self,
        path: &str,
        query: impl Into<Option<serde_json::Value>> + Send,
    ) -> ChainResult<Option<T>> {
        self.track_request(path, || self.inner.request_optional(path, query))
            .await
    }

    /// Makes a POST request to the API
    async fn request_post<T: DeserializeOwned + Send>(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> ChainResult<T> {
        self.track_request(path, || self.inner.request_post(path, body))
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::MetricHttpClient;
    use crate::provider::BaseHttpClient;

    #[test]
    fn transaction_endpoints_have_distinct_metric_methods() {
        assert_eq!(
            MetricHttpClient::<BaseHttpClient>::method("transaction/confirmed/id"),
            "transaction_confirmed"
        );
        assert_eq!(
            MetricHttpClient::<BaseHttpClient>::method("transaction/unconfirmed/id"),
            "transaction_unconfirmed"
        );
        assert_eq!(
            MetricHttpClient::<BaseHttpClient>::method("transaction/broadcast"),
            "transaction_broadcast"
        );
    }
}
