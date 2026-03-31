use std::{future::Future, time::Instant};

use async_trait::async_trait;
use core_api_client::models::{
    NetworkStatusResponse, TransactionCallPreviewRequest, TransactionCallPreviewResponse,
};
use gateway_api_client::models::{
    CommittedTransactionInfo, GatewayStatusResponse, StateEntityDetailsRequest,
    StateEntityDetailsResponse, StreamTransactionsRequest, StreamTransactionsResponse,
    TransactionCommittedDetailsRequest, TransactionPreviewV2Request, TransactionPreviewV2Response,
    TransactionStatusResponse, TransactionSubmitResponse,
};

use hyperlane_core::{rpc_clients::BlockNumberGetter, ChainCommunicationError, ChainResult};
use url::Url;

use crate::{
    RadixBaseCoreProvider, RadixBaseGatewayProvider, RadixCoreProvider, RadixGatewayProvider,
};
use hyperlane_metric::prometheus_metric::{
    ChainInfo, ClientConnectionType, PrometheusClientMetrics, PrometheusConfig,
};

#[derive(Debug, Clone)]
pub struct RadixMetricGatewayProvider {
    client: RadixBaseGatewayProvider,
    metrics: PrometheusClientMetrics,
    config: PrometheusConfig,
}

#[derive(Debug, Clone)]
pub struct RadixMetricCoreProvider {
    client: RadixBaseCoreProvider,
    metrics: PrometheusClientMetrics,
    config: PrometheusConfig,
}

impl RadixMetricGatewayProvider {
    pub fn new(
        base: RadixBaseGatewayProvider,
        url: &Url,
        metrics: PrometheusClientMetrics,
        chain: Option<ChainInfo>,
    ) -> Self {
        let config = PrometheusConfig::from_url(url, ClientConnectionType::Rpc, chain);
        Self {
            client: base,
            metrics,
            config,
        }
    }
    async fn track_metric_call<F, Fut, T>(&self, method: &str, call: F) -> ChainResult<T>
    where
        F: Fn() -> Fut,
        Fut: Future<Output = Result<T, ChainCommunicationError>>,
    {
        let start = Instant::now();
        let res = call().await;

        self.metrics
            .increment_metrics(&self.config, method, start, res.is_ok());

        res
    }
}

impl RadixMetricCoreProvider {
    pub fn new(
        base: RadixBaseCoreProvider,
        url: &Url,
        metrics: PrometheusClientMetrics,
        chain: Option<ChainInfo>,
    ) -> Self {
        let config = PrometheusConfig::from_url(url, ClientConnectionType::Rpc, chain);
        Self {
            client: base,
            metrics,
            config,
        }
    }
    async fn track_metric_call<F, Fut, T>(&self, method: &str, call: F) -> ChainResult<T>
    where
        F: Fn() -> Fut,
        Fut: Future<Output = Result<T, ChainCommunicationError>>,
    {
        let start = Instant::now();
        let res = call().await;

        self.metrics
            .increment_metrics(&self.config, method, start, res.is_ok());

        res
    }
}

#[async_trait]
impl RadixGatewayProvider for RadixMetricGatewayProvider {
    async fn gateway_status(&self) -> ChainResult<GatewayStatusResponse> {
        self.track_metric_call("gateway_status", || self.client.gateway_status())
            .await
    }

    async fn transaction_committed(
        &self,
        tx_intent: TransactionCommittedDetailsRequest,
    ) -> ChainResult<CommittedTransactionInfo> {
        self.track_metric_call("transaction_committed", || {
            self.client.transaction_committed(tx_intent.clone())
        })
        .await
    }

    async fn submit_transaction(&self, tx: Vec<u8>) -> ChainResult<TransactionSubmitResponse> {
        self.track_metric_call("submit_transaction", || {
            self.client.submit_transaction(tx.clone())
        })
        .await
    }

    async fn transaction_preview(
        &self,
        request: TransactionPreviewV2Request,
    ) -> ChainResult<TransactionPreviewV2Response> {
        self.track_metric_call("transaction_preview", || {
            self.client.transaction_preview(request.clone())
        })
        .await
    }

    async fn stream_txs(
        &self,
        request: StreamTransactionsRequest,
    ) -> ChainResult<StreamTransactionsResponse> {
        self.track_metric_call("stream_txs", || self.client.stream_txs(request.clone()))
            .await
    }

    async fn transaction_status(
        &self,
        intent_hash: String,
    ) -> ChainResult<TransactionStatusResponse> {
        self.track_metric_call("transaction_status", || {
            self.client.transaction_status(intent_hash.clone())
        })
        .await
    }

    async fn entity_details(
        &self,
        request: StateEntityDetailsRequest,
    ) -> ChainResult<StateEntityDetailsResponse> {
        self.track_metric_call("entity_details", || {
            self.client.entity_details(request.clone())
        })
        .await
    }
}

// For RadixCoreProvider methods
#[async_trait]
impl RadixCoreProvider for RadixMetricCoreProvider {
    async fn core_status(&self) -> ChainResult<NetworkStatusResponse> {
        self.track_metric_call("core_status", || self.client.core_status())
            .await
    }

    async fn call_preview(
        &self,
        request: TransactionCallPreviewRequest,
    ) -> ChainResult<TransactionCallPreviewResponse> {
        self.track_metric_call("call_preview", || self.client.call_preview(request.clone()))
            .await
    }
}

#[async_trait]
impl BlockNumberGetter for RadixMetricGatewayProvider {
    /// Latest block number getter
    async fn get_block_number(&self) -> ChainResult<u64> {
        self.client.get_block_number().await
    }
}

#[async_trait]
impl BlockNumberGetter for RadixMetricCoreProvider {
    /// Latest block number getter
    async fn get_block_number(&self) -> ChainResult<u64> {
        self.client.get_block_number().await
    }
}
