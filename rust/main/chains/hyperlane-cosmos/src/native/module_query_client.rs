use cosmrs::{Any, Tx};
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
    MsgProcessMessage, QueryDeliveredRequest, QueryDeliveredResponse, QueryMailboxRequest,
    QueryMailboxResponse, QueryRecipientIsmRequest, QueryRecipientIsmResponse,
};
use hyperlane_cosmos_rs::hyperlane::warp::v1::MsgRemoteTransfer;
use hyperlane_cosmos_rs::prost::{Message, Name};
use tonic::async_trait;

use hyperlane_core::{
    ChainCommunicationError, ChainResult, HyperlaneMessage, RawHyperlaneMessage, H256, H512,
};

use crate::GrpcProvider;
use crate::{BuildableQueryClient, HyperlaneCosmosError};

/// Query Client for the Hyperlane Cosmos module
/// the client provides queries for the state of the Hyperlane application living on a Cosmos chain
#[derive(Clone, Debug)]
pub struct ModuleQueryClient {
    /// grpc provider
    grpc: GrpcProvider,
}

#[async_trait]
impl BuildableQueryClient for ModuleQueryClient {
    fn build_query_client(
        grpc: GrpcProvider,
        _conf: &crate::ConnectionConf,
        _locator: &hyperlane_core::ContractLocator,
        _signer: Option<crate::Signer>,
    ) -> hyperlane_core::ChainResult<Self> {
        Ok(Self { grpc })
    }

    // the tx is either a MsgPorcessMessage on the destination or a MsgRemoteTransfer on the origin
    // we check for both tx types, if both are missing or an error occurred while parsing we return the error
    fn parse_tx_message_recipient(&self, tx: &Tx, _hash: &H512) -> ChainResult<H256> {
        // first check for the process message
        if let Some(recipient) = Self::parse_msg_process_recipient(tx)? {
            return Ok(recipient);
        }
        // if not found check for the remote transfer
        if let Some(recipient) = Self::parse_msg_remote_transfer_recipient(tx)? {
            return Ok(recipient);
        }
        // if both are missing we return an error
        Err(HyperlaneCosmosError::ParsingFailed(
            "transaction does not contain any process message or remote transfer".to_owned(),
        ))?
    }

    async fn is_contract(&self, _address: &H256) -> ChainResult<bool> {
        return Ok(true);
    }

    /// Returns the Block height of the query client
    async fn get_block_number(&self) -> ChainResult<u64> {
        self.grpc.get_block_number().await
    }
}

impl ModuleQueryClient {
    /// parses the message recipient if the transaction contains a MsgProcessMessage
    fn parse_msg_process_recipient(tx: &Tx) -> ChainResult<Option<H256>> {
        // check for all messages processes
        let processed_messages: Vec<Any> = tx
            .body
            .messages
            .iter()
            .filter(|a| a.type_url == MsgProcessMessage::type_url())
            .cloned()
            .collect();

        // right now one transaction can include max. one process
        if processed_messages.len() > 1 {
            let msg = "transaction contains multiple execution messages";
            Err(HyperlaneCosmosError::ParsingFailed(msg.to_owned()))?
        }

        let msg = processed_messages.first();
        match msg {
            Some(msg) => {
                let result = MsgProcessMessage::decode(msg.value.as_slice())
                    .map_err(HyperlaneCosmosError::from)?;
                let message: RawHyperlaneMessage = hex::decode(result.message)?;
                let message = HyperlaneMessage::from(message);
                Ok(Some(message.recipient))
            }
            None => Ok(None),
        }
    }

    /// parses the message recipient if the transaction contains a MsgRemoteTransfer
    fn parse_msg_remote_transfer_recipient(tx: &Tx) -> ChainResult<Option<H256>> {
        // check for all remote transfers
        let remote_transfers: Vec<Any> = tx
            .body
            .messages
            .iter()
            .filter(|a| a.type_url == MsgRemoteTransfer::type_url())
            .cloned()
            .collect();

        // right now one transaction can include max. one transfer
        if remote_transfers.len() > 1 {
            let msg = "transaction contains multiple execution messages";
            Err(HyperlaneCosmosError::ParsingFailed(msg.to_owned()))?
        }

        let msg = remote_transfers.first().ok_or_else(|| {
            ChainCommunicationError::from_other_str("tx does not contain any remote transfers")
        })?;
        let result =
            MsgRemoteTransfer::decode(msg.value.as_slice()).map_err(HyperlaneCosmosError::from)?;
        // the recipient is the token id of the transfer, which is the address that the user interacts with
        let recipient: H256 = result.token_id.parse()?;
        Ok(Some(recipient))
    }

    fn request_at_height<T>(
        request: impl tonic::IntoRequest<T>,
        height: Option<u64>,
    ) -> tonic::Request<T> {
        let mut request = request.into_request();
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
        height: Option<u64>,
    ) -> ChainResult<QueryMailboxResponse> {
        self.grpc
            .call(|client| {
                let id = id.clone();
                let future = async move {
                    let mut service = QueryClient::new(client.channel());
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
        self.grpc
            .call(|client| {
                let mailbox = mailbox.clone();
                let validator = validator.clone();
                let future = async move {
                    let mut service = IsmQueryClient::new(client.channel());
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
        self.grpc
            .call(|client| {
                let recipient = recipient.clone();
                let future = async move {
                    let mut service = QueryClient::new(client.channel());
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
        height: Option<u64>,
    ) -> ChainResult<QueryMerkleTreeHookResponse> {
        self.grpc
            .call(|client| {
                let id = id.clone();
                let future = async move {
                    let mut service = PostDispatchQueryClient::new(client.channel());
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
        self.grpc
            .call(|client| {
                let mailbox_id = mailbox_id.clone();
                let message_id = message_id.clone();
                let future = async move {
                    let mut service = QueryClient::new(client.channel());
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
        self.grpc
            .call(|client| {
                let id = id.clone();
                let future = async move {
                    let mut service = IsmQueryClient::new(client.channel());
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
