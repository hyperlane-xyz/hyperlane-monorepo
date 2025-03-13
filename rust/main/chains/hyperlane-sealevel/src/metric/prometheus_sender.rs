use std::time::Instant;

use hyperlane_metric::prometheus_metric::{PrometheusClientMetrics, PrometheusConfig};
use solana_client::{
    client_error::ClientError,
    http_sender::HttpSender,
    rpc_request::RpcRequest,
    rpc_sender::{RpcSender, RpcTransportStats},
};
use url::Url;

/// Sealevel RPC with prometheus metrics
/// Wraps around HttpSender
/// https://github.com/anza-xyz/agave/blob/master/rpc-client/src/http_sender.rs#L137
pub struct PrometheusSealevelRpcSender {
    pub url: Url,
    pub inner: HttpSender,
    pub metrics: PrometheusClientMetrics,
    pub config: PrometheusConfig,
}

impl Clone for PrometheusSealevelRpcSender {
    fn clone(&self) -> Self {
        Self {
            url: self.url.clone(),
            inner: HttpSender::new(self.url.clone()),
            metrics: self.metrics.clone(),
            config: self.config.clone(),
        }
    }
}

impl std::fmt::Debug for PrometheusSealevelRpcSender {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "PrometheusSealevelRpcSender {{ url: {} }}", self.url)
    }
}

impl PrometheusSealevelRpcSender {
    pub fn new(url: Url, metrics: PrometheusClientMetrics, config: PrometheusConfig) -> Self {
        Self {
            url: url.clone(),
            inner: HttpSender::new(url),
            metrics,
            config,
        }
    }
}

/// Implement this trait so it can be used with Solana RPC Client
#[async_trait::async_trait]
impl RpcSender for PrometheusSealevelRpcSender {
    fn get_transport_stats(&self) -> RpcTransportStats {
        self.inner.get_transport_stats()
    }

    async fn send(
        &self,
        request: RpcRequest,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, ClientError> {
        let start = Instant::now();
        let method = format!("{}", request);

        let res = self.inner.send(request, params).await;

        self.metrics
            .increment_metrics(&self.config, &method, start, res.is_ok());
        res
    }
    fn url(&self) -> String {
        self.inner.url()
    }
}
