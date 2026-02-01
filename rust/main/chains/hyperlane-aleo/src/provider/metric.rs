use std::{ops::Deref, time::Instant};

use async_trait::async_trait;
use snarkvm_console_account::DeserializeOwned;
use url::Url;

use hyperlane_core::ChainResult;
use hyperlane_metric::prometheus_metric::{PrometheusClientMetrics, PrometheusConfig};

use crate::provider::{AleoClient, BaseHttpClient, HttpClient, HttpClientBuilder, RpcClient};

/// Normalizes dynamic API paths to static method names for metrics.
/// This prevents high-cardinality labels from paths like "block/15544045".
fn normalize_method(path: &str) -> &'static str {
    // Static paths that don't contain dynamic values
    match path {
        "block/latest" => return "block/latest",
        "block/height/latest" => return "block/height/latest",
        "block/hash/latest" => return "block/hash/latest",
        "stateRoot/latest" => return "stateRoot/latest",
        "transaction/broadcast" => return "transaction/broadcast",
        _ => {}
    }

    // Dynamic paths - order matters for correct matching
    if path.starts_with("block/") && path.ends_with("/transactions") {
        return "get_block_transactions";
    }
    if path.starts_with("block/") {
        return "get_block";
    }
    if path.starts_with("find/blockHash/") {
        return "find_block_hash";
    }
    if path.starts_with("program/") && path.contains("/mapping/") {
        return "get_mapping_value";
    }
    if path.starts_with("program/") && path.ends_with("/mappings") {
        return "get_program_mappings";
    }
    if path.starts_with("program/") && path.ends_with("/latest_edition") {
        return "get_latest_edition";
    }
    if path.starts_with("program/") {
        return "get_program";
    }
    if path.starts_with("transaction/confirmed/") {
        return "get_confirmed_transaction";
    }
    if path.starts_with("transaction/unconfirmed/") {
        return "get_unconfirmed_transaction";
    }
    if path.starts_with("transaction/") {
        return "get_transaction";
    }
    if path.starts_with("statePath/") {
        return "get_state_path";
    }
    if path.starts_with("statePaths") {
        return "get_state_paths";
    }

    "unknown"
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
        self.metrics
            .increment_metrics(&self.metrics_config, normalize_method(path), start, res.is_ok());
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
