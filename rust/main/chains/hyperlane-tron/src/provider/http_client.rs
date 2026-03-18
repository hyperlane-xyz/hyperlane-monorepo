use std::future::Future;
use std::ops::Deref;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use reqwest::Client;
use serde::de::DeserializeOwned;
use url::Url;

use hyperlane_core::rpc_clients::{BlockNumberGetter, FallbackProvider};
use hyperlane_core::{ChainCommunicationError, ChainResult};
use hyperlane_metric::prometheus_metric::{
    ChainInfo, ClientConnectionType, PrometheusClientMetrics, PrometheusConfig,
};
use reqwest_utils::parse_custom_rpc_headers;

use super::types::{
    BlockResponse, BroadcastResponse, EstimateEnergyResponse, TriggerConstantResponse,
    TriggerContractRequest,
};
use crate::HyperlaneTronError;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// HTTP-based Tron provider
#[derive(Clone, Debug)]
pub struct TronHttpProvider {
    fallback: FallbackProvider<TronHttpChannel, TronHttpChannel>,
}

/// A single HTTP channel used by the FallbackProvider
#[derive(Clone, Debug)]
pub struct TronHttpChannel {
    client: Client,
    base_url: Url,
    metrics: PrometheusClientMetrics,
    config: PrometheusConfig,
}

impl TronHttpChannel {
    fn new(
        url: &Url,
        metrics: PrometheusClientMetrics,
        chain: Option<ChainInfo>,
    ) -> ChainResult<Self> {
        let (headers, clean_url) =
            parse_custom_rpc_headers(url).map_err(ChainCommunicationError::from_other)?;
        let client = Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .default_headers(headers)
            .build()
            .map_err(HyperlaneTronError::from)?;
        let config = PrometheusConfig::from_url(&clean_url, ClientConnectionType::Rpc, chain);
        Ok(Self {
            client,
            base_url: clean_url,
            metrics,
            config,
        })
    }

    async fn track_metric_call<F, Fut, T>(&self, method: &str, call: F) -> ChainResult<T>
    where
        F: Fn() -> Fut,
        Fut: Future<Output = ChainResult<T>>,
    {
        let start = Instant::now();
        let res = call().await;
        self.metrics
            .increment_metrics(&self.config, method, start, res.is_ok());
        res
    }

    async fn post_json<R: DeserializeOwned, B: serde::Serialize>(
        &self,
        path: &str,
        body: B,
    ) -> ChainResult<R> {
        let url = format!("{}{}", self.base_url.as_str().trim_end_matches('/'), path);
        let resp = self
            .client
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(HyperlaneTronError::from)?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(HyperlaneTronError::HttpResponseError {
                status: status.as_u16(),
                body,
            }
            .into());
        }
        resp.json::<R>()
            .await
            .map_err(|e| HyperlaneTronError::from(e).into())
    }
}

#[async_trait]
impl BlockNumberGetter for TronHttpChannel {
    async fn get_block_number(&self) -> Result<u64, ChainCommunicationError> {
        let block: BlockResponse = self
            .post_json("/getnowblock", &serde_json::json!({}))
            .await?;
        Ok(block.block_header.raw_data.number as u64)
    }
}

impl TronHttpProvider {
    /// Create a new TronHttpProvider from a list of URLs
    pub fn new(
        urls: Vec<Url>,
        metrics: PrometheusClientMetrics,
        chain: Option<ChainInfo>,
    ) -> ChainResult<Self> {
        let channels = urls
            .iter()
            .map(|url| TronHttpChannel::new(url, metrics.clone(), chain.clone()))
            .collect::<Result<Vec<_>, _>>()?;
        let fallback = FallbackProvider::new(channels);
        Ok(Self { fallback })
    }

    /// Get the current block
    pub async fn get_now_block(&self) -> ChainResult<BlockResponse> {
        self.fallback
            .call(|channel| {
                let future = async move {
                    channel
                        .track_metric_call("get_now_block", || {
                            channel.post_json("/getnowblock", serde_json::json!({}))
                        })
                        .await
                };
                Box::pin(future)
            })
            .await
    }

    /// Get a block by number
    pub async fn get_block_by_num(&self, num: i64) -> ChainResult<BlockResponse> {
        self.fallback
            .call(|channel| {
                let future = async move {
                    channel
                        .track_metric_call("get_block_by_num", || {
                            channel.post_json("/getblockbynum", serde_json::json!({"num": num}))
                        })
                        .await
                };
                Box::pin(future)
            })
            .await
    }

    /// Call a contract (read-only)
    pub async fn trigger_constant_contract(
        &self,
        req: TriggerContractRequest,
    ) -> ChainResult<TriggerConstantResponse> {
        self.fallback
            .call(|channel| {
                let req = req.clone();
                let future = async move {
                    channel
                        .track_metric_call("trigger_constant_contract", || {
                            channel.post_json("/triggerconstantcontract", req.clone())
                        })
                        .await
                };
                Box::pin(future)
            })
            .await
    }

    /// Estimate energy for a transaction
    pub async fn estimate_energy(
        &self,
        req: TriggerContractRequest,
    ) -> ChainResult<EstimateEnergyResponse> {
        self.fallback
            .call(|channel| {
                let req = req.clone();
                let future = async move {
                    channel
                        .track_metric_call("estimate_energy", || {
                            channel.post_json("/wallet/estimateenergy", req.clone())
                        })
                        .await
                };
                Box::pin(future)
            })
            .await
    }

    /// Broadcast a hex-encoded transaction
    pub async fn broadcast_hex(&self, hex_transaction: String) -> ChainResult<BroadcastResponse> {
        self.fallback
            .call(|channel| {
                let hex_transaction = hex_transaction.clone();
                let future = async move {
                    channel
                        .track_metric_call("broadcast_hex", || {
                            channel.post_json(
                                "/wallet/broadcasthex",
                                serde_json::json!({"transaction": hex_transaction}),
                            )
                        })
                        .await
                };
                Box::pin(future)
            })
            .await
    }
}

impl Deref for TronHttpProvider {
    type Target = FallbackProvider<TronHttpChannel, TronHttpChannel>;
    fn deref(&self) -> &Self::Target {
        &self.fallback
    }
}
