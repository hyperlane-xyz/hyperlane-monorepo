use std::sync::Arc;

use hyperlane_metric::prometheus_metric::{
    ChainInfo, ClientConnectionType, PrometheusClientMetrics, PrometheusConfig,
};
use solana_client::{nonblocking::rpc_client::RpcClient, rpc_client::RpcClientConfig};
use solana_sdk::commitment_config::CommitmentConfig;
use url::Url;

use crate::client::SealevelRpcClient;
use crate::metric::prometheus_sender::PrometheusSealevelRpcSender;

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
        chain: Option<ChainInfo>,
    ) -> Self {
        let metrics_config =
            PrometheusConfig::from_url(&self.rpc_url, ClientConnectionType::Rpc, chain);
        self.prometheus_config = Some((metrics, metrics_config));
        self
    }

    /// build SealevelRpcClient
    pub fn build(self) -> SealevelRpcClient {
        let (metrics, metrics_config) = self.prometheus_config.unwrap_or_default();

        let sender = PrometheusSealevelRpcSender::new(self.rpc_url, metrics, metrics_config);
        let rpc_client = RpcClient::new_sender(
            sender,
            RpcClientConfig::with_commitment(CommitmentConfig::processed()),
        );

        SealevelRpcClient::from_rpc_client(Arc::new(rpc_client))
    }
}
