use hyperlane_core::rpc_clients::{BlockNumberGetter, FallbackProvider};
use hyperlane_cosmos_rs::cosmos::base::tendermint::v1beta1::service_client::ServiceClient;
use hyperlane_cosmos_rs::cosmos::base::tendermint::v1beta1::{
    GetLatestBlockRequest, GetNodeInfoRequest,
};
use hyperlane_cosmos_rs::hyperlane::core::interchain_security::v1::{
    query_client::QueryClient as IsmQueryClient, QueryAnnouncedStorageLocationsRequest,
    QueryAnnouncedStorageLocationsResponse, QueryIsmRequest, QueryIsmResponse,
};
use hyperlane_cosmos_rs::hyperlane::core::post_dispatch::v1::{
    query_client::QueryClient as PostDispatchQueryClient, QueryMerkleTreeHook,
    QueryMerkleTreeHookResponse,
};
use hyperlane_cosmos_rs::hyperlane::core::v1::query_client::QueryClient;
use hyperlane_cosmos_rs::hyperlane::core::v1::{
    QueryDeliveredRequest, QueryDeliveredResponse, QueryMailboxRequest, QueryMailboxResponse,
    RecipientIsmRequest, RecipientIsmResponse,
};
use itertools::Itertools;
use tonic::async_trait;
use tonic::transport::{Channel, Endpoint};

use hyperlane_core::{ChainCommunicationError, ChainResult};

use crate::{ConnectionConf, HyperlaneCosmosError};

/// Grpc Provider
#[derive(Clone, Debug)]
pub struct GrpcProvider {
    fallback: FallbackProvider<CosmosGrpcClient, CosmosGrpcClient>,
}

#[derive(Debug, Clone)]
struct CosmosGrpcClient {
    channel: Channel,
}

#[async_trait]
impl BlockNumberGetter for CosmosGrpcClient {
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
impl GrpcProvider {
    /// todo
    pub fn new(conf: ConnectionConf) -> ChainResult<Self> {
        let clients = conf
            .get_grpc_urls()
            .iter()
            .map(|url| Endpoint::new(url.to_string()))
            .map_ok(|endpoint| {
                let channel = endpoint.connect_lazy();
                CosmosGrpcClient { channel }
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
        if let Some(height) = height {
            request
                .metadata_mut()
                .insert("x-cosmos-block-height", height.into());
        }
        request
    }

    /// todo
    pub async fn mailbox(
        &self,
        id: String,
        height: Option<u32>,
    ) -> ChainResult<QueryMailboxResponse> {
        self.fallback
            .call(|client| {
                let id = id.clone();
                let height = height.clone();
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

    /// todo
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

    /// todo
    pub async fn recipient_ism(&self, recipient: String) -> ChainResult<RecipientIsmResponse> {
        self.fallback
            .call(|client| {
                let recipient = recipient.clone();
                let future = async move {
                    let mut service = QueryClient::new(client.channel.clone());
                    let result = service
                        .recipient_ism(RecipientIsmRequest { recipient })
                        .await
                        .map_err(HyperlaneCosmosError::from)?
                        .into_inner();
                    Ok(result)
                };
                Box::pin(future)
            })
            .await
    }

    /// todo
    pub async fn merkle_tree_hook(
        &self,
        id: String,
        height: Option<u32>,
    ) -> ChainResult<QueryMerkleTreeHookResponse> {
        self.fallback
            .call(|client| {
                let id = id.clone();
                let height = height.clone();
                let future = async move {
                    let mut service = PostDispatchQueryClient::new(client.channel.clone());
                    let result = service
                        .merkle_tree_hook(Self::request_at_height(
                            QueryMerkleTreeHook { id },
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

    /// todo
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

    /// todo
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
}
