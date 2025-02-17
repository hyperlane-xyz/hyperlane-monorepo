use hyperlane_metric::prometheus_metric::{PrometheusClientMetrics, PrometheusConfig};
use solana_client::{nonblocking::rpc_client::RpcClient, rpc_client::RpcClientConfig};
use solana_sdk::commitment_config::CommitmentConfig;
use url::Url;

use crate::metric::prometheus_sender::PrometheusSealevelRpcSender;

use super::SealevelRpcClient;

#[derive(Clone)]
/// SealevelRpcClient builder
pub struct SealevelRpcClientBuilder {
    rpc_url: Url,
    prometheus_config: Option<(PrometheusClientMetrics, PrometheusConfig)>,
}

impl SealevelRpcClientBuilder {
    /// Instantiate builder
    pub fn new(rpc_url: Url) -> Self {
        Self {
            rpc_url,
            prometheus_config: None,
        }
    }

    /// add prometheus metrics to builder
    pub fn with_prometheus_metrics(
        mut self,
        metrics: PrometheusClientMetrics,
        config: PrometheusConfig,
    ) -> Self {
        self.prometheus_config = Some((metrics, config));
        self
    }

    /// build SealevelRpcClient
    pub fn build(self) -> SealevelRpcClient {
        let (metrics, metrics_config) = self.prometheus_config.unwrap_or_else(|| {
            (
                PrometheusClientMetrics {
                    request_count: None,
                    request_duration_seconds: None,
                },
                PrometheusConfig {
                    node: None,
                    chain: None,
                },
            )
        });

        let sender = PrometheusSealevelRpcSender::new(self.rpc_url, metrics, metrics_config);
        let rpc_client = RpcClient::new_sender(
            sender,
            RpcClientConfig::with_commitment(CommitmentConfig::processed()),
        );
        SealevelRpcClient(rpc_client)
    }
}
