use std::ops::Deref;
use std::time::Duration;

use derive_new::new;
use tonic::async_trait;
use tonic::transport::{Channel, Endpoint};
use tron_rs::tron::protocol::wallet_solidity_client::WalletSolidityClient;
use tron_rs::tron::protocol::EmptyMessage;
use url::Url;

use hyperlane_core::rpc_clients::{BlockNumberGetter, FallbackProvider};
use hyperlane_core::{ChainCommunicationError, ChainResult};
use hyperlane_metric::prometheus_metric::{
    ChainInfo, ClientConnectionType, PrometheusClientMetrics, PrometheusConfig,
};

use crate::{HyperlaneTronError, MetricsChannel};

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
    /// Not explicitly used, but useful for debugging.
    _url: Url,
}

#[async_trait]
impl BlockNumberGetter for GrpcChannel {
    async fn get_block_number(&self) -> Result<u64, ChainCommunicationError> {
        let mut client = WalletSolidityClient::new(self.channel.clone())
            .max_decoding_message_size(MAX_MESSAGE_SIZE);
        let block = client
            .get_now_block2(EmptyMessage {})
            .await
            .map_err(HyperlaneTronError::from)?
            .into_inner();
        if let Some(block_header) = block.block_header {
            if let Some(raw_data) = block_header.raw_data {
                return Ok(raw_data.number as u64);
            }
        }

        Err(HyperlaneTronError::MissingBlockHeader.into())
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
        urls: Vec<Url>,
        metrics: PrometheusClientMetrics,
        chain: Option<ChainInfo>,
    ) -> ChainResult<Self> {
        let clients = urls
            .into_iter()
            .map(|url| {
                let metrics_config =
                    PrometheusConfig::from_url(&url, ClientConnectionType::Grpc, chain.clone());
                Endpoint::new(url.to_string())
                    .map(|e| e.timeout(REQUEST_TIMEOUT))
                    .map(|e| e.connect_timeout(REQUEST_TIMEOUT))
                    .map(|e| MetricsChannel::new(e.connect_lazy(), metrics.clone(), metrics_config))
                    .map(|m| GrpcChannel::new(m, url))
                    .map_err(Into::<HyperlaneTronError>::into)
            })
            .collect::<Result<Vec<GrpcChannel>, _>>()?;

        let fallback = FallbackProvider::new(clients);
        Ok(Self { fallback })
    }
}

impl Deref for GrpcProvider {
    type Target = FallbackProvider<GrpcChannel, GrpcChannel>;
    fn deref(&self) -> &Self::Target {
        &self.fallback
    }
}
