use std::time::{Duration, Instant};

use hyperlane_metric::prometheus_metric::{
    PrometheusClientMetrics, PrometheusConfig, PrometheusConfigExt,
};
use solana_client::{
    client_error::{ClientError, ClientErrorKind},
    rpc_request::RpcRequest,
};
use solana_rpc_client::{
    http_sender::HttpSender,
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
    request_timeout: Duration,
}

impl std::fmt::Debug for PrometheusSealevelRpcSender {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let stats = self.inner.get_transport_stats();
        f.debug_struct("PrometheusSealevelRpcSender")
            .field("rpc_host", &self.config.node_host())
            .field("chain", &self.config.chain)
            .field("connection_type", &self.config.connection_type)
            .field("rpc_role", &self.config.rpc_role)
            .field("request_timeout", &self.request_timeout)
            .field("request_count", &stats.request_count)
            .field("elapsed_time", &stats.elapsed_time)
            .field("rate_limited_time", &stats.rate_limited_time)
            .finish_non_exhaustive()
    }
}

impl PrometheusSealevelRpcSender {
    pub fn new(url: Url, metrics: PrometheusClientMetrics, config: PrometheusConfig) -> Self {
        // increment provider metric count
        let chain_name = PrometheusConfig::chain_name(&config.chain);
        metrics.increment_provider_instance(chain_name);

        let timeout = std::env::var("SEALEVEL_RPC_CLIENT_ELEVATED_TIMEOUT_SECONDS")
            .ok()
            .unwrap_or("30".to_string())
            .parse::<u64>()
            .unwrap_or(30u64);

        let request_timeout = Duration::from_secs(timeout);
        let inner = HttpSender::new_with_timeout(url, request_timeout);

        Self {
            inner,
            metrics,
            config,
            request_timeout,
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
        let method = format!("{request}");

        let res = self
            .inner
            .send(request, params)
            .await
            .map_err(|error| ClientError {
                request: error.request,
                kind: Box::new(match *error.kind {
                    ClientErrorKind::Reqwest(error) => {
                        ClientErrorKind::Reqwest(error.without_url())
                    }
                    kind => kind,
                }),
            });

        self.metrics
            .increment_metrics(&self.config, &method, start, res.is_ok());
        res
    }
    fn url(&self) -> String {
        self.inner.url()
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn diagnostics_omit_rpc_credentials() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let url = Url::parse(&format!("http://{address}/private-path?key=private-query")).unwrap();
        let config = PrometheusConfig::from_url(&url, Default::default(), None);
        let sender = PrometheusSealevelRpcSender::new(url, Default::default(), config);
        let debug = format!("{sender:?}");
        assert!(!debug.contains("private-"));
        assert!(debug.contains(&format!(r#"rpc_host: "{address}""#)));
        assert!(debug.contains("request_timeout:"));
        assert!(debug.contains("request_count: 0"));
        assert!(debug.contains("rate_limited_time: 0ns"));
        let error = sender
            .send(RpcRequest::GetBlockHeight, serde_json::json!([]))
            .await
            .unwrap_err();
        assert!(!format!("{error:?} {error}").contains("private-"));
        let ClientErrorKind::Reqwest(error) = *error.kind else {
            panic!("expected HTTP error");
        };
        assert!(error.url().is_none());
        assert!(error.is_connect());
        assert!(format!("{sender:?}").contains("request_count: 1"));
    }
}
