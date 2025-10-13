use async_trait::async_trait;
use core_api_client::models::{
    NetworkStatusResponse, TransactionCallPreviewRequest, TransactionCallPreviewResponse,
};
use derive_new::new;
use gateway_api_client::models::{
    CommittedTransactionInfo, GatewayStatusResponse, StateEntityDetailsRequest,
    StateEntityDetailsResponse, StreamTransactionsRequest, StreamTransactionsResponse,
    TransactionCommittedDetailsRequest, TransactionPreviewV2Request, TransactionPreviewV2Response,
    TransactionStatusResponse, TransactionSubmitResponse,
};

use hyperlane_core::{rpc_clients::FallbackProvider, ChainResult};

use crate::{
    provider::metric::{RadixMetricCoreProvider, RadixMetricGatewayProvider},
    RadixCoreProvider, RadixGatewayProvider,
};

/// Radix fallback provider
#[derive(new, Debug, Clone)]
pub struct RadixFallbackProvider {
    core: FallbackProvider<RadixMetricCoreProvider, RadixMetricCoreProvider>,
    gateway: FallbackProvider<RadixMetricGatewayProvider, RadixMetricGatewayProvider>,
}

#[async_trait]
impl RadixGatewayProvider for RadixFallbackProvider {
    async fn gateway_status(&self) -> ChainResult<GatewayStatusResponse> {
        self.gateway
            .call(|client| {
                let future = async move { client.gateway_status().await };
                Box::pin(future)
            })
            .await
    }

    async fn transaction_committed(
        &self,
        tx_intent: TransactionCommittedDetailsRequest,
    ) -> ChainResult<CommittedTransactionInfo> {
        self.gateway
            .call(|client| {
                let tx_intent = tx_intent.clone();
                let future = async move { client.transaction_committed(tx_intent).await };
                Box::pin(future)
            })
            .await
    }

    async fn submit_transaction(&self, tx: Vec<u8>) -> ChainResult<TransactionSubmitResponse> {
        self.gateway
            .call(|client| {
                let tx = tx.clone();
                let future = async move { client.submit_transaction(tx).await };
                Box::pin(future)
            })
            .await
    }

    async fn transaction_preview(
        &self,
        request: TransactionPreviewV2Request,
    ) -> ChainResult<TransactionPreviewV2Response> {
        self.gateway
            .call(|client| {
                let request = request.clone();
                let future = async move { client.transaction_preview(request).await };
                Box::pin(future)
            })
            .await
    }

    async fn stream_txs(
        &self,
        request: StreamTransactionsRequest,
    ) -> ChainResult<StreamTransactionsResponse> {
        self.gateway
            .call(|client| {
                let request = request.clone();
                let future = async move { client.stream_txs(request).await };
                Box::pin(future)
            })
            .await
    }

    async fn transaction_status(
        &self,
        intent_hash: String,
    ) -> ChainResult<TransactionStatusResponse> {
        self.gateway
            .call(|client| {
                let intent_hash = intent_hash.clone();
                let future = async move { client.transaction_status(intent_hash).await };
                Box::pin(future)
            })
            .await
    }

    async fn entity_details(
        &self,
        request: StateEntityDetailsRequest,
    ) -> ChainResult<StateEntityDetailsResponse> {
        self.gateway
            .call(|client| {
                let request = request.clone();
                let future = async move { client.entity_details(request).await };
                Box::pin(future)
            })
            .await
    }
}

#[async_trait]
impl RadixCoreProvider for RadixFallbackProvider {
    async fn core_status(&self) -> ChainResult<NetworkStatusResponse> {
        self.core
            .call(|client| {
                let future = async move { client.core_status().await };
                Box::pin(future)
            })
            .await
    }

    async fn call_preview(
        &self,
        request: TransactionCallPreviewRequest,
    ) -> ChainResult<TransactionCallPreviewResponse> {
        self.core
            .call(|client| {
                let request = request.clone();
                let future = async move { client.call_preview(request).await };
                Box::pin(future)
            })
            .await
    }
}
