use std::time::Duration;

use derive_new::new;
use hyperlane_cosmos_rs::cosmos::base::tendermint::v1beta1::service_client::ServiceClient;
use hyperlane_cosmos_rs::cosmos::base::tendermint::v1beta1::GetLatestBlockRequest;
use hyperlane_cosmos_rs::dymensionxyz::dymension::kas::{
    query_client::QueryClient as KasQueryClient, QueryOutpointRequest, QueryOutpointResponse,
    QueryWithdrawalStatusRequest, QueryWithdrawalStatusResponse, WithdrawalId,
};
use hyperlane_cosmos_rs::hyperlane::core::interchain_security::v1::{
    query_client::QueryClient as IsmQueryClient, QueryAnnouncedStorageLocationsRequest,
    QueryAnnouncedStorageLocationsResponse, QueryIsmRequest, QueryIsmResponse,
};
use hyperlane_cosmos_rs::hyperlane::core::post_dispatch::v1::{
    query_client::QueryClient as PostDispatchQueryClient, QueryMerkleTreeHookRequest,
    QueryMerkleTreeHookResponse,
};
use hyperlane_cosmos_rs::hyperlane::core::v1::query_client::QueryClient;
use hyperlane_cosmos_rs::hyperlane::core::v1::{
    QueryDeliveredRequest, QueryDeliveredResponse, QueryMailboxRequest, QueryMailboxResponse,
    QueryRecipientIsmRequest, QueryRecipientIsmResponse,
};
use tonic::async_trait;
use tonic::transport::{Channel, Endpoint};

use hyperlane_core::rpc_clients::{BlockNumberGetter, FallbackProvider};
use hyperlane_core::{ChainCommunicationError, ChainResult};
use hyperlane_metric::prometheus_metric::{
    ChainInfo, ClientConnectionType, PrometheusClientMetrics, PrometheusConfig,
};

use crate::prometheus::metrics_channel::MetricsChannel;
use crate::{ConnectionConf, HyperlaneCosmosError};

const REQUEST_TIMEOUT: u64 = 30;

/// Grpc Provider
#[derive(Clone, Debug)]
pub struct GrpcProvider {
    fallback: FallbackProvider<CosmosGrpcClient, CosmosGrpcClient>,
}

#[derive(Debug, Clone, new)]
struct CosmosGrpcClient {
    channel: MetricsChannel<Channel>,
}

#[async_trait]
impl BlockNumberGetter for CosmosGrpcClient {
    async fn get_block_number(&self) -> Result<u64, ChainCommunicationError> {
        let mut client = ServiceClient::new(self.channel.clone());
        let mut request = tonic::Request::new(GetLatestBlockRequest {});
        request.set_timeout(Duration::from_secs(REQUEST_TIMEOUT));
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
impl GrpcProvider {
    /// New GrpcProvider
    pub fn new(
        conf: ConnectionConf,
        metrics: PrometheusClientMetrics,
        chain: Option<ChainInfo>,
    ) -> ChainResult<Self> {
        let clients = conf
            .get_grpc_urls()
            .iter()
            .map(|url| {
                let metrics_config =
                    PrometheusConfig::from_url(url, ClientConnectionType::Grpc, chain.clone());
                Endpoint::new(url.to_string())
                    .map(|e| e.timeout(Duration::from_secs(REQUEST_TIMEOUT)))
                    .map(|e| e.connect_timeout(Duration::from_secs(REQUEST_TIMEOUT)))
                    .map(|e| MetricsChannel::new(e.connect_lazy(), metrics.clone(), metrics_config))
                    .map(CosmosGrpcClient::new)
                    .map_err(Into::<HyperlaneCosmosError>::into)
            })
            .collect::<Result<Vec<CosmosGrpcClient>, _>>()
            .map_err(HyperlaneCosmosError::from)?;

        let fallback = FallbackProvider::new(clients);
        Ok(Self { fallback })
    }

    fn request_at_height<T>(
        request: impl tonic::IntoRequest<T>,
        height: Option<u32>,
    ) -> tonic::Request<T> {
        let mut request = request.into_request();
        request.set_timeout(Duration::from_secs(REQUEST_TIMEOUT));
        if let Some(height) = height {
            request
                .metadata_mut()
                .insert("x-cosmos-block-height", height.into());
        }
        request
    }

    /// Mailbox struct at given height
    pub async fn mailbox(
        &self,
        id: String,
        height: Option<u32>,
    ) -> ChainResult<QueryMailboxResponse> {
        self.fallback
            .call(|client| {
                let id = id.clone();
                let future = async move {
                    let mut service = QueryClient::new(client.channel.clone());
                    let result = service
                        .mailbox(Self::request_at_height(QueryMailboxRequest { id }, height))
                        .await
                        .map_err(HyperlaneCosmosError::from)?
                        .into_inner();
                    Ok(result)
                };
                Box::pin(future)
            })
            .await
    }

    /// All of the storage locations of a validator
    ///
    /// Note: a validators storage locations are depended on the mailbox
    pub async fn announced_storage_locations(
        &self,
        mailbox: String,
        validator: String,
    ) -> ChainResult<QueryAnnouncedStorageLocationsResponse> {
        self.fallback
            .call(|client| {
                let mailbox = mailbox.clone();
                let validator = validator.clone();
                let future = async move {
                    let mut service = IsmQueryClient::new(client.channel.clone());
                    let result = service
                        .announced_storage_locations(QueryAnnouncedStorageLocationsRequest {
                            mailbox_id: mailbox,
                            validator_address: validator,
                        })
                        .await
                        .map_err(HyperlaneCosmosError::from)?
                        .into_inner();
                    Ok(result)
                };
                Box::pin(future)
            })
            .await
    }

    /// ISM for a given recipient
    ///
    /// Recipient is a 32 byte long hex address
    /// Mailbox independent query as one application (recipient) can only ever register on one mailbox
    pub async fn recipient_ism(&self, recipient: String) -> ChainResult<QueryRecipientIsmResponse> {
        self.fallback
            .call(|client| {
                let recipient = recipient.clone();
                let future = async move {
                    let mut service = QueryClient::new(client.channel.clone());
                    let result = service
                        .recipient_ism(QueryRecipientIsmRequest { recipient })
                        .await
                        .map_err(HyperlaneCosmosError::from)?
                        .into_inner();
                    Ok(result)
                };
                Box::pin(future)
            })
            .await
    }

    /// merkle tree hook
    ///
    /// also contains the current root of the branches
    pub async fn merkle_tree_hook(
        &self,
        id: String,
        height: Option<u32>,
    ) -> ChainResult<QueryMerkleTreeHookResponse> {
        self.fallback
            .call(|client| {
                let id = id.clone();
                let future = async move {
                    let mut service = PostDispatchQueryClient::new(client.channel.clone());
                    let result = service
                        .merkle_tree_hook(Self::request_at_height(
                            QueryMerkleTreeHookRequest { id },
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

    /// checks if a message has been delivered to the given mailbox
    pub async fn delivered(
        &self,
        mailbox_id: String,
        message_id: String,
    ) -> ChainResult<QueryDeliveredResponse> {
        self.fallback
            .call(|client| {
                let mailbox_id = mailbox_id.clone();
                let message_id = message_id.clone();
                let future = async move {
                    let mut service = QueryClient::new(client.channel.clone());
                    let result = service
                        .delivered(QueryDeliveredRequest {
                            id: mailbox_id,
                            message_id,
                        })
                        .await
                        .map_err(HyperlaneCosmosError::from)?
                        .into_inner();
                    Ok(result)
                };
                Box::pin(future)
            })
            .await
    }

    /// ism for a given id
    ///
    /// Note: this query will only ever work for the core ISMs that are directly supported by the cosmos module
    /// because the cosmos module forces extensions to be stored in external keepers (Cosmos SDK specific).
    /// As a result, extensions have to provide custom queries for their types, meaning if we want to support a custom ISM at some point - that is not provided by the default hyperlane cosmos module -
    /// we'd have to query a custom endpoint for the ISMs as well.
    pub async fn ism(&self, id: String) -> ChainResult<QueryIsmResponse> {
        self.fallback
            .call(|client| {
                let id = id.clone();
                let future = async move {
                    let mut service = IsmQueryClient::new(client.channel.clone());
                    let result = service
                        .ism(QueryIsmRequest { id })
                        .await
                        .map_err(HyperlaneCosmosError::from)?
                        .into_inner();
                    Ok(result)
                };
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
}
