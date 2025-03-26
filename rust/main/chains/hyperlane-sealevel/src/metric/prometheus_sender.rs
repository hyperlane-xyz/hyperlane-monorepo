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
    pub inner: HttpSender,
    pub metrics: PrometheusClientMetrics,
    pub config: PrometheusConfig,
}

impl PrometheusSealevelRpcSender {
    pub fn new(url: Url, metrics: PrometheusClientMetrics, config: PrometheusConfig) -> Self {
        // increment provider metric count
        let chain_name = PrometheusConfig::chain_name(&config.chain);
        metrics.increment_provider_instance(chain_name);

        Self {
            inner: HttpSender::new(url),
            metrics,
            config,
        }
    }
}

impl Drop for PrometheusSealevelRpcSender {
    fn drop(&mut self) {
        // decrement provider metric count when dropped
        let chain_name = PrometheusConfig::chain_name(&self.config.chain);
        self.metrics.decrement_provider_instance(chain_name);
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
