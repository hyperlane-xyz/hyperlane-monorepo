use std::{ops::Deref, time::Instant};

use async_trait::async_trait;
use snarkvm_console_account::DeserializeOwned;
use url::Url;

use hyperlane_core::ChainResult;
use hyperlane_metric::prometheus_metric::{PrometheusClientMetrics, PrometheusConfig};

use crate::provider::{AleoClient, BaseHttpClient, HttpClient, HttpClientBuilder, RpcClient};

#[derive(Clone, Copy)]
pub enum ExecutionPhase {
    DelegatedProverPreflight,
    Authorization,
    DelegatedProverProof,
}

impl ExecutionPhase {
    const fn method(self) -> &'static str {
        match self {
            Self::DelegatedProverPreflight => "delegated_prover_preflight",
            Self::Authorization => "aleo_authorization",
            Self::DelegatedProverProof => "delegated_prover_proof",
        }
    }
}

/// Records a bounded high-level Aleo execution phase using the standard client metrics.
pub fn record_execution_phase(
    metrics: &PrometheusClientMetrics,
    metrics_config: &PrometheusConfig,
    phase: ExecutionPhase,
    start: Instant,
    success: bool,
) {
    metrics.increment_metrics(metrics_config, phase.method(), start, success);
}

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
    use std::time::Instant;

    use hyperlane_metric::prometheus_metric::{
        ChainInfo, PrometheusClientMetricsBuilder, REQUEST_COUNT_LABELS,
    };
    use prometheus::{IntCounterVec, Opts};

    use super::{record_execution_phase, ExecutionPhase, MetricHttpClient};
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

    #[test]
    fn execution_phase_metrics_use_a_fixed_phase_label() {
        let request_count = IntCounterVec::new(
            Opts::new("test_request_count", "test request count"),
            REQUEST_COUNT_LABELS,
        )
        .expect("valid request metric");
        let metrics = PrometheusClientMetricsBuilder::default()
            .request_count(request_count.clone())
            .build()
            .expect("valid client metrics");
        let metrics_config = hyperlane_metric::prometheus_metric::PrometheusConfig {
            chain: Some(ChainInfo {
                name: Some("aleo-testnet".to_string()),
            }),
            ..Default::default()
        };

        for (phase, method, status) in [
            (
                ExecutionPhase::DelegatedProverPreflight,
                "delegated_prover_preflight",
                "failure",
            ),
            (
                ExecutionPhase::Authorization,
                "aleo_authorization",
                "success",
            ),
            (
                ExecutionPhase::DelegatedProverProof,
                "delegated_prover_proof",
                "success",
            ),
        ] {
            record_execution_phase(
                &metrics,
                &metrics_config,
                phase,
                Instant::now(),
                status == "success",
            );
            assert_eq!(
                request_count
                    .with_label_values(&[
                        "unknown",
                        "rpc",
                        "aleo-testnet",
                        method,
                        status,
                        "primary",
                    ])
                    .get(),
                1,
            );
        }
    }
}
