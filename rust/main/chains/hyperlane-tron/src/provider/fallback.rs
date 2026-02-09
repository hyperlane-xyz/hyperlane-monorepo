use async_trait::async_trait;
use itertools::Itertools;
use serde::de::DeserializeOwned;
use url::Url;

use hyperlane_core::{
    rpc_clients::{BlockNumberGetter, FallbackProvider},
    ChainResult,
};
use hyperlane_metric::prometheus_metric::{
    ClientConnectionType, PrometheusClientMetrics, PrometheusConfig,
};

use crate::provider::base::TronBaseHttpClient;
use crate::provider::metric::MetricHttpClient;
use crate::provider::traits::{HttpClient, HttpClientBuilder, TronClient, TronRpcClient};

/// Fallback Http Client that tries multiple RpcClients in order
#[derive(Clone, Debug)]
pub struct TronFallbackHttpClient<C: TronClient = TronBaseHttpClient> {
    fallback:
        FallbackProvider<TronRpcClient<MetricHttpClient<C>>, TronRpcClient<MetricHttpClient<C>>>,
}

impl<C: TronClient> TronFallbackHttpClient<C> {
    /// Creates a new TronFallbackHttpClient from a list of base urls
    pub fn new<Builder: HttpClientBuilder<Client = C>>(
        urls: Vec<Url>,
        metrics: PrometheusClientMetrics,
        chain: Option<hyperlane_metric::prometheus_metric::ChainInfo>,
    ) -> ChainResult<Self> {
        let clients = urls
            .into_iter()
            .map(|url| {
                let metrics_config =
                    PrometheusConfig::from_url(&url, ClientConnectionType::Rpc, chain.clone());
                MetricHttpClient::new::<Builder>(url, metrics.clone(), metrics_config)
            })
            .collect::<ChainResult<Vec<_>>>()?
            .into_iter()
            .map(TronRpcClient::new)
            .collect_vec();
        let fallback = FallbackProvider::new(clients);
        Ok(Self { fallback })
    }
}

#[async_trait]
impl<C: HttpClient + std::fmt::Debug + Send + Sync> BlockNumberGetter for TronRpcClient<C> {
    async fn get_block_number(&self) -> ChainResult<u64> {
        let block = self.get_now_block().await?;
        Ok(block.block_header.raw_data.number)
    }
}

#[async_trait]
impl<C: TronClient> HttpClient for TronFallbackHttpClient<C> {
    async fn request_post<T: DeserializeOwned + Send>(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> ChainResult<T> {
        self.fallback
            .call(|inner| {
                let path = path.to_string();
                let body = body.clone();
                let future = async move { inner.request_post(&path, &body).await };
                Box::pin(future)
            })
            .await
    }
}
