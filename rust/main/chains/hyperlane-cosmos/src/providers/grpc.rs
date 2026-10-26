use hyperlane_metric::utils::url_to_host_info;
use std::ops::Deref;
use std::time::Duration;

use derive_new::new;
use tonic::async_trait;
use tonic::transport::{Channel, Endpoint};

use hyperlane_core::rpc_clients::{BlockNumberGetter, FallbackProvider};
use hyperlane_core::{ChainCommunicationError, ChainResult, ReorgPeriod};
use hyperlane_metric::prometheus_metric::{
    ChainInfo, ClientConnectionType, PrometheusClientMetrics, PrometheusConfig,
};
use redact::Secret;

use cosmrs::proto::cosmos::base::tendermint::v1beta1::service_client::ServiceClient;
use cosmrs::proto::cosmos::base::tendermint::v1beta1::GetLatestValidatorSetRequest;
use url::Url;

use crate::{ConnectionConf, HyperlaneCosmosError, MetricsChannel};

/// Grpc Provider
#[derive(Clone, Debug)]
pub struct GrpcProvider {
    fallback: FallbackProvider<GrpcChannel, GrpcChannel>,
}

/// gRPC request timeout
const MAX_MESSAGE_SIZE: usize = 8 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// GrpcChannel is a wrapper used by the FallbackProvider
/// implements BlockNumberGetter
#[derive(Debug, Clone, new)]
pub struct GrpcChannel {
    channel: MetricsChannel<Channel>,
    /// The url that this channel is connected to.
    /// Retained as a secret because channel diagnostics must not print credentials.
    _url: Secret<Url>,
}

#[async_trait]
impl BlockNumberGetter for GrpcChannel {
    async fn get_block_number(&self) -> Result<u64, ChainCommunicationError> {
        let mut client =
            ServiceClient::new(self.channel.clone()).max_decoding_message_size(MAX_MESSAGE_SIZE);
        let request = tonic::Request::new(GetLatestValidatorSetRequest { pagination: None });
        let response = client
            .get_latest_validator_set(request)
            .await
            .map_err(ChainCommunicationError::from_other)?
            .into_inner();
        let height = response.block_height;
        Ok(height as u64)
    }
}

impl GrpcChannel {
    /// Get the channel
    pub fn channel(&self) -> MetricsChannel<Channel> {
        self.channel.clone()
    }
}

impl GrpcProvider {
    /// New GrpcProvider
    pub fn new(
        conf: &ConnectionConf,
        metrics: PrometheusClientMetrics,
        chain: Option<ChainInfo>,
    ) -> ChainResult<Self> {
        let urls = conf.get_grpc_urls();
        let hosts = urls.iter().map(url_to_host_info).collect();
        let clients = urls
            .into_iter()
            .map(|url| {
                let metrics_config =
                    PrometheusConfig::from_url(&url, ClientConnectionType::Grpc, chain.clone());
                Endpoint::new(url.to_string())
                    .map(|e| e.timeout(REQUEST_TIMEOUT))
                    .map(|e| e.connect_timeout(REQUEST_TIMEOUT))
                    .map(|e| MetricsChannel::new(e.connect_lazy(), metrics.clone(), metrics_config))
                    .map(|m| GrpcChannel::new(m, Secret::new(url)))
                    .map_err(Into::<HyperlaneCosmosError>::into)
            })
            .collect::<Result<Vec<GrpcChannel>, _>>()?;

        let fallback = FallbackProvider::new(clients).with_rpc_context(
            PrometheusConfig::chain_name(&chain).to_owned(),
            "grpcUrls",
            hosts,
        );
        Ok(Self { fallback })
    }

    /// Get the block number according to the reorg period
    pub async fn get_block_number(&self) -> ChainResult<u64> {
        self.call(|provider| {
            let future = async move { provider.get_block_number().await };
            Box::pin(future)
        })
        .await
    }
}

impl Deref for GrpcProvider {
    type Target = FallbackProvider<GrpcChannel, GrpcChannel>;
    fn deref(&self) -> &Self::Target {
        &self.fallback
    }
}

#[cfg(test)]
mod credential_tests {
    use super::*;

    #[tokio::test]
    async fn grpc_channel_debug_omits_endpoint_credentials() {
        let url =
            Url::parse("http://user:private-password@localhost/private-path?key=private-query")
                .unwrap();
        let channel = Endpoint::new(url.to_string()).unwrap().connect_lazy();
        let channel = GrpcChannel::new(
            MetricsChannel::new(channel, Default::default(), Default::default()),
            Secret::new(url),
        );
        let output = format!("{channel:?}");
        assert!(!output.contains("private-"));
        assert!(output.contains("[REDACTED"));
    }
}
