use async_trait::async_trait;
use core_api_client::apis::configuration::Configuration as CoreConfig;
use core_api_client::models::{
    NetworkStatusRequest, NetworkStatusResponse, TransactionCallPreviewRequest,
    TransactionCallPreviewResponse,
};
use derive_new::new;
use gateway_api_client::apis::configuration::Configuration as GatewayConfig;
use gateway_api_client::models::{
    CommittedTransactionInfo, GatewayStatusResponse, StateEntityDetailsRequest,
    StateEntityDetailsResponse, StreamTransactionsRequest, StreamTransactionsResponse,
    TransactionCommittedDetailsRequest, TransactionPreviewV2Request, TransactionPreviewV2Response,
    TransactionStatusRequest, TransactionStatusResponse, TransactionSubmitRequest,
    TransactionSubmitResponse,
};
use scrypto::network::NetworkDefinition;

use hyperlane_core::rpc_clients::BlockNumberGetter;
use hyperlane_core::ChainResult;

use crate::HyperlaneRadixError;

mod fallback;
mod lander;
mod metric;
mod radix;

pub use {
    fallback::RadixFallbackProvider,
    lander::RadixProviderForLander,
    radix::{RadixProvider, RadixTxCalldata},
};

/// Base Raidx provider
/// defined the most basic methods the provider has to implement.
/// Provides abstraction over the radix providers, that allows to implement features like Fallback behaviour
#[async_trait]
pub trait RadixGatewayProvider {
    /// Gateway status
    async fn gateway_status(&self) -> ChainResult<GatewayStatusResponse>;
    /// Get committed transaction details
    async fn transaction_committed(
        &self,
        tx_intent: TransactionCommittedDetailsRequest,
    ) -> ChainResult<CommittedTransactionInfo>;
    /// Submits a tx to the gateway
    async fn submit_transaction(&self, tx: Vec<u8>) -> ChainResult<TransactionSubmitResponse>;
    /// Get a preview of the tx
    async fn transaction_preview(
        &self,
        request: TransactionPreviewV2Request,
    ) -> ChainResult<TransactionPreviewV2Response>;
    /// Get committed tx by various filters
    async fn stream_txs(
        &self,
        request: StreamTransactionsRequest,
    ) -> ChainResult<StreamTransactionsResponse>;
    /// Get tx status
    async fn transaction_status(
        &self,
        intent_hash: String,
    ) -> ChainResult<TransactionStatusResponse>;
    /// Get entity details
    async fn entity_details(
        &self,
        request: StateEntityDetailsRequest,
    ) -> ChainResult<StateEntityDetailsResponse>;
}

#[async_trait]
/// Radix core provider
pub trait RadixCoreProvider {
    /// Core status
    async fn core_status(&self) -> ChainResult<NetworkStatusResponse>;
    /// Call preview a contract method
    async fn call_preview(
        &self,
        request: TransactionCallPreviewRequest,
    ) -> ChainResult<TransactionCallPreviewResponse>;
}

/// Base Radix provider
#[derive(new, Debug, Clone)]
pub struct RadixBaseGatewayProvider {
    gateway: GatewayConfig,
}

/// Base Radix provider
#[derive(new, Debug, Clone)]
pub struct RadixBaseCoreProvider {
    core: CoreConfig,
    network: NetworkDefinition,
}

#[async_trait]
impl BlockNumberGetter for RadixBaseGatewayProvider {
    /// Latest block number getter
    async fn get_block_number(&self) -> ChainResult<u64> {
        let state = self.gateway_status().await?;
        Ok(state.ledger_state.state_version as u64)
    }
}

#[async_trait]
impl BlockNumberGetter for RadixBaseCoreProvider {
    /// Latest block number getter
    async fn get_block_number(&self) -> ChainResult<u64> {
        let state = core_api_client::apis::status_api::status_network_status_post(
            &self.core,
            NetworkStatusRequest {
                network: self.network.logical_name.to_string(),
            },
        )
        .await
        .map_err(HyperlaneRadixError::from)?;
        Ok(state.current_state_identifier.state_version)
    }
}

#[async_trait]
impl RadixGatewayProvider for RadixBaseGatewayProvider {
    async fn gateway_status(&self) -> ChainResult<GatewayStatusResponse> {
        Ok(
            gateway_api_client::apis::status_api::gateway_status(&self.gateway)
                .await
                .map_err(HyperlaneRadixError::from)?,
        )
    }

    async fn transaction_committed(
        &self,
        request: TransactionCommittedDetailsRequest,
    ) -> ChainResult<CommittedTransactionInfo> {
        Ok(
            gateway_api_client::apis::transaction_api::transaction_committed_details(
                &self.gateway,
                request,
            )
            .await
            .map_err(HyperlaneRadixError::from)?
            .transaction,
        )
    }

    async fn submit_transaction(&self, tx: Vec<u8>) -> ChainResult<TransactionSubmitResponse> {
        Ok(
            gateway_api_client::apis::transaction_api::transaction_submit(
                &self.gateway,
                TransactionSubmitRequest {
                    notarized_transaction_hex: hex::encode(tx),
                },
            )
            .await
            .map_err(HyperlaneRadixError::from)?,
        )
    }

    async fn transaction_preview(
        &self,
        request: TransactionPreviewV2Request,
    ) -> ChainResult<TransactionPreviewV2Response> {
        Ok(
            gateway_api_client::apis::transaction_api::transaction_preview_v2(
                &self.gateway,
                request,
            )
            .await
            .map_err(HyperlaneRadixError::from)?,
        )
    }

    async fn transaction_status(
        &self,
        intent_hash: String,
    ) -> ChainResult<TransactionStatusResponse> {
        Ok(
            gateway_api_client::apis::transaction_api::transaction_status(
                &self.gateway,
                TransactionStatusRequest { intent_hash },
            )
            .await
            .map_err(HyperlaneRadixError::from)?,
        )
    }

    async fn stream_txs(
        &self,
        request: StreamTransactionsRequest,
    ) -> ChainResult<StreamTransactionsResponse> {
        Ok(
            gateway_api_client::apis::stream_api::stream_transactions(&self.gateway, request)
                .await
                .map_err(HyperlaneRadixError::from)?,
        )
    }

    async fn entity_details(
        &self,
        request: StateEntityDetailsRequest,
    ) -> ChainResult<StateEntityDetailsResponse> {
        Ok(
            gateway_api_client::apis::state_api::state_entity_details(&self.gateway, request)
                .await
                .map_err(HyperlaneRadixError::from)?,
        )
    }
}

#[async_trait]
impl RadixCoreProvider for RadixBaseCoreProvider {
    async fn core_status(&self) -> ChainResult<NetworkStatusResponse> {
        Ok(
            core_api_client::apis::status_api::status_network_status_post(
                &self.core,
                NetworkStatusRequest {
                    network: self.network.logical_name.to_string(),
                },
            )
            .await
            .map_err(HyperlaneRadixError::from)?,
        )
    }

    async fn call_preview(
        &self,
        request: TransactionCallPreviewRequest,
    ) -> ChainResult<TransactionCallPreviewResponse> {
        Ok(
            core_api_client::apis::transaction_api::transaction_call_preview_post(
                &self.core, request,
            )
            .await
            .map_err(HyperlaneRadixError::from)?,
        )
    }
}
