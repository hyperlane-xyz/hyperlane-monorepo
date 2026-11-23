use std::time::Instant;

use async_trait::async_trait;
use hyperlane_core::{rpc_clients::BlockNumberGetter, ChainCommunicationError, ChainResult};
use hyperlane_metric::prometheus_metric::{
    PrometheusClientMetrics, PrometheusConfig, PrometheusConfigExt,
};
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
pub struct MetricProvider {
    client: HttpTransport,
    metrics: PrometheusClientMetrics,
    metrics_config: PrometheusConfig,
    custom_header_count: usize,
}

impl std::fmt::Debug for MetricProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MetricProvider")
            .field("rpc_host", &self.metrics_config.node_host())
            .field("chain", &self.metrics_config.chain)
            .field("connection_type", &self.metrics_config.connection_type)
            .field("rpc_role", &self.metrics_config.rpc_role)
            .field("custom_header_count", &self.custom_header_count)
            .finish_non_exhaustive()
    }
}

impl MetricProvider {
    fn redact_error(error: HttpTransportError) -> HttpTransportError {
        match error {
            HttpTransportError::Reqwest(error) => HttpTransportError::Reqwest(error.without_url()),
            error => error,
        }
    }

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
        let custom_header_count = headers.len();
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
            custom_header_count,
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
            custom_header_count: self.custom_header_count,
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
        P: Serialize + Send + Sync,
        R: DeserializeOwned + Send,
    {
        let start = Instant::now();
        let params_json = serde_json::to_value(params).map_err(Self::Error::Json)?;
        let result = self
            .client
            .send_request(method, params_json)
            .await
            .map_err(Self::redact_error);
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
        let result = self
            .client
            .send_requests(requests)
            .await
            .map_err(Self::redact_error);
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
        let json_rpc = JsonRpcClient::new(self.clone());
        json_rpc
            .block_number()
            .await
            .map_err(HyperlaneStarknetError::from)
            .map_err(ChainCommunicationError::from)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn debug_omits_rpc_credentials() {
        let url = Url::parse("http://private-user:private-password@localhost/private-path?key=private-query&custom_rpc_header=Authorization:Bearer%20private-header").unwrap();
        let config = PrometheusConfig::from_url(&url, Default::default(), None);
        let provider = MetricProvider::new(url, Default::default(), config).unwrap();
        let debug = format!("{provider:?}");
        assert!(!debug.contains("private-"));
        assert!(debug.contains(r#"rpc_host: "localhost:80""#));
        assert!(debug.contains("custom_header_count: 1"));
        assert!(debug.contains("connection_type: Rpc"));
        assert!(debug.contains("rpc_role: Primary"));
    }

    #[tokio::test]
    async fn request_errors_omit_rpc_credentials() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let provider = MetricProvider::new(
            Url::parse(&format!("http://{address}/private-path?key=private-query")).unwrap(),
            Default::default(),
            Default::default(),
        )
        .unwrap();
        let single = provider
            .send_request::<_, serde_json::Value>(JsonRpcMethod::BlockNumber, ())
            .await
            .unwrap_err();
        let batch = provider
            .send_requests(Vec::<ProviderRequestData>::new())
            .await
            .unwrap_err();
        for error in [single, batch] {
            let HttpTransportError::Reqwest(error) = error else {
                panic!("expected transport error");
            };
            assert!(error.url().is_none());
            assert!(error.is_connect());
            assert!(!format!("{error:?} {error}").contains("private-"));
        }
        let error = provider.get_block_number().await.unwrap_err();
        assert!(!format!("{error:?} {error}").contains("private-"));
    }
}
