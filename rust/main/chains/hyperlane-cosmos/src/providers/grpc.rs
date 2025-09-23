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
use hyperlane_cosmos_rs::dymensionxyz::dymension::kas::{
    query_client::QueryClient as KasQueryClient, QueryOutpointRequest, QueryOutpointResponse,
    QueryWithdrawalStatusRequest, QueryWithdrawalStatusResponse, WithdrawalId,
};

use cosmrs::proto::cosmos::base::tendermint::v1beta1::service_client::ServiceClient;
use cosmrs::proto::cosmos::base::tendermint::v1beta1::GetLatestBlockRequest;
use url::Url;

use crate::{ConnectionConf, HyperlaneCosmosError, MetricsChannel};

/// Grpc Provider
#[derive(Clone, Debug)]
pub struct GrpcProvider {
    fallback: FallbackProvider<GrpcChannel, GrpcChannel>,
}

/// gRPC request timeout
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
        let mut client = ServiceClient::new(self.channel.clone());
        let request = tonic::Request::new(GetLatestBlockRequest {});
        let response = client
            .get_latest_block(request)
            .await
            .map_err(ChainCommunicationError::from_other)?
            .into_inner();
        let height = response
            .block
            .ok_or_else(|| ChainCommunicationError::from_other_str("block not present"))?
            .header
            .ok_or_else(|| ChainCommunicationError::from_other_str("header not present"))?
            .height;

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
        let clients = conf
            .get_grpc_urls()
            .into_iter()
            .map(|url| {
                let metrics_config =
                    PrometheusConfig::from_url(&url, ClientConnectionType::Grpc, chain.clone());
                Endpoint::new(url.to_string())
                    .map(|e| e.timeout(REQUEST_TIMEOUT))
                    .map(|e| e.connect_timeout(REQUEST_TIMEOUT))
                    .map(|e| MetricsChannel::new(e.connect_lazy(), metrics.clone(), metrics_config))
                    .map(|m| GrpcChannel::new(m, url))
                    .map_err(Into::<HyperlaneCosmosError>::into)
            })
            .collect::<Result<Vec<GrpcChannel>, _>>()?;

        let fallback = FallbackProvider::new(clients);
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

     /// Query the current outpoint (anchor) for Kaspa bridge
     pub async fn outpoint(&self, height: Option<u32>) -> ChainResult<QueryOutpointResponse> {
        self.fallback
            .call(|client| {
                let future = async move {
                    let mut service = KasQueryClient::new(client.channel.clone());
                    let result = service
                        .outpoint(Self::request_at_height(QueryOutpointRequest {}, height))
                        .await
                        .map_err(HyperlaneCosmosError::from)?
                        .into_inner();
                    Ok(result)
                };
                Box::pin(future)
            })
            .await
    }

    /// Query withdrawal status by withdrawal ID
    pub async fn withdrawal_status(
        &self,
        withdrawal_id: Vec<WithdrawalId>,
        height: Option<u32>,
    ) -> ChainResult<QueryWithdrawalStatusResponse> {
        self.fallback
            .call(|client| {
                let withdrawal_id = withdrawal_id.clone();
                let future = async move {
                    let mut service = KasQueryClient::new(client.channel.clone());
                    let result = service
                        .withdrawal_status(Self::request_at_height(
                            QueryWithdrawalStatusRequest { withdrawal_id },
                            height,
                        ))
                        .await
                        .map_err(HyperlaneCosmosError::from)?
                        .into_inner();
                    Ok(result)
                };
                Box::pin(future)
            })
            .await
    }

    /// bit of a hack, we can see if the hub x/kas is bootstrapped by doing an empty withdrawal query
    /// https://github.com/dymensionxyz/dymension/blob/55468f6494cc233d7478a658964881c465c46555/x/kas/keeper/grpc_query.go#L30
    pub async fn hub_bootstrapped(&self) -> ChainResult<bool> {
        let ws_res = self.withdrawal_status(vec![], None).await;
        match ws_res {
            Ok(_) => Ok(true),
            Err(e) => Err(e),
        }
    }
}

impl Deref for GrpcProvider {
    type Target = FallbackProvider<GrpcChannel, GrpcChannel>;
    fn deref(&self) -> &Self::Target {
        &self.fallback
    }
}
