use std::time::Instant;

use async_trait::async_trait;
use hyperlane_core::{rpc_clients::BlockNumberGetter, ChainCommunicationError, ChainResult};
use hyperlane_metric::prometheus_metric::{PrometheusClientMetrics, PrometheusConfig};
use reqwest_utils::parse_custom_rpc_headers;
use serde::{de::DeserializeOwned, Serialize};
use starknet::providers::{
    jsonrpc::{
        HttpTransport, HttpTransportError, JsonRpcMethod, JsonRpcResponse, JsonRpcTransport,
    },
    JsonRpcClient, Provider, ProviderRequestData,
};
use url::Url;

use crate::HyperlaneStarknetError;

/// Starknet Metric Provider
#[derive(Debug)]
pub struct MetricProvider {
    client: HttpTransport,
    metrics: PrometheusClientMetrics,
    metrics_config: PrometheusConfig,
}

impl MetricProvider {
    /// Create new Starknet `MetricProvider`
    pub fn new(
        url: Url,
        metrics: PrometheusClientMetrics,
        metrics_config: PrometheusConfig,
    ) -> ChainResult<Self> {
        // increment provider metric count
        let chain_name = PrometheusConfig::chain_name(&metrics_config.chain);
        metrics.increment_provider_instance(chain_name);

        let (headers, url) =
            parse_custom_rpc_headers(&url).map_err(ChainCommunicationError::from_other)?;
        let mut client = HttpTransport::new(url);
        for (name, value) in headers.iter() {
            let name = name.to_string();
            let value = value
                .to_str()
                .map_err(|_| {
                    ChainCommunicationError::from_other_str(&format!(
                        "Invalid header value for header: {name}: {value:?}",
                    ))
                })?
                .to_string();
            client.add_header(name, value);
        }

        Ok(Self {
            client,
            metrics,
            metrics_config,
        })
    }
}

impl Clone for MetricProvider {
    fn clone(&self) -> Self {
        // increment provider metric count
        let chain_name = PrometheusConfig::chain_name(&self.metrics_config.chain);
        self.metrics.increment_provider_instance(chain_name);

        Self {
            client: self.client.clone(),
            metrics: self.metrics.clone(),
            metrics_config: self.metrics_config.clone(),
        }
    }
}

impl Drop for MetricProvider {
    fn drop(&mut self) {
        // decrement provider metric count
        let chain_name = PrometheusConfig::chain_name(&self.metrics_config.chain);
        self.metrics.decrement_provider_instance(chain_name);
    }
}

#[async_trait]
impl JsonRpcTransport for MetricProvider {
    type Error = HttpTransportError;

    async fn send_request<P, R>(
        &self,
        method: JsonRpcMethod,
        params: P,
    ) -> Result<JsonRpcResponse<R>, Self::Error>
    where
        P: Serialize + Send,
        R: DeserializeOwned + Send,
    {
        let start = Instant::now();
        let params_json = serde_json::to_value(params).map_err(Self::Error::Json)?;
        let result = self.client.send_request(method, params_json).await;
        let method_string = serde_json::to_string(&method).map_err(Self::Error::Json)?;
        self.metrics
            .increment_metrics(&self.metrics_config, &method_string, start, result.is_ok());

        result
    }

    async fn send_requests<R>(
        &self,
        requests: R,
    ) -> Result<Vec<JsonRpcResponse<serde_json::Value>>, Self::Error>
    where
        R: AsRef<[ProviderRequestData]> + Send + Sync,
    {
        let request_slice = requests.as_ref();
        let method_strings: Vec<String> = request_slice
            .iter()
            .filter_map(|req| {
                serde_json::to_value(req)
                    .ok()
                    .and_then(|v| v.get("method").cloned())
                    .map(|m| m.to_string())
            })
            .collect();
        let start = Instant::now();
        let result = self.client.send_requests(requests).await;
        for method_string in &method_strings {
            self.metrics.increment_metrics(
                &self.metrics_config,
                method_string,
                start,
                result.is_ok(),
            );
        }
        result
    }
}

// Useful for Fallback provider
#[async_trait]
impl BlockNumberGetter for MetricProvider {
    /// Latest block number getter
    async fn get_block_number(&self) -> ChainResult<u64> {
        let json_rpc = JsonRpcClient::new(self.client.clone());
        json_rpc
            .block_number()
            .await
            .map_err(HyperlaneStarknetError::from)
            .map_err(ChainCommunicationError::from)
    }
}
