//! A wrapper around a JsonRpcClient to give insight at the request level. This
//! was designed specifically for use with the quorum provider.

use std::fmt::{Debug, Formatter};
use std::time::Instant;

use async_trait::async_trait;
use derive_new::new;
use ethers::prelude::JsonRpcClient;
use ethers_core::types::U64;
use hyperlane_core::rpc_clients::BlockNumberGetter;
use hyperlane_core::ChainCommunicationError;
use hyperlane_metric::prometheus_metric::{
    PrometheusClientMetrics, PrometheusConfig, PrometheusConfigExt,
};
use serde::{de::DeserializeOwned, Serialize};

/// An ethers-rs JsonRpcClient wrapper that instruments requests with prometheus
/// metrics. To make this as flexible as possible, the metric vecs need to be
/// created and named externally, they should follow the naming convention here
/// and must include the described labels.
#[derive(new)]
pub struct PrometheusJsonRpcClient<C> {
    inner: C,
    metrics: PrometheusClientMetrics,
    config: PrometheusConfig,
}

impl<C: Clone> Clone for PrometheusJsonRpcClient<C> {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
            metrics: self.metrics.clone(),
            config: self.config.clone(),
        }
    }
}

impl<C> Debug for PrometheusJsonRpcClient<C>
where
    C: JsonRpcClient,
{
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(f, "PrometheusJsonRpcClient({:?})", self.inner)
    }
}

impl<C> PrometheusJsonRpcClient<C> {
    /// The inner RpcClient implementation
    pub fn inner(&self) -> &C {
        &self.inner
    }
}

impl<C> PrometheusConfigExt for PrometheusJsonRpcClient<C> {
    /// The "host" part of the URL this node is connecting to. E.g.
    /// `avalanche.api.onfinality.io`.
    fn node_host(&self) -> &str {
        self.config.node_host()
    }

    /// Chain name this RPC client is connected to.
    fn chain_name(&self) -> &str {
        self.config.chain_name()
    }
}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
impl<C> JsonRpcClient for PrometheusJsonRpcClient<C>
where
    C: JsonRpcClient,
{
    type Error = C::Error;

    async fn request<T, R>(&self, method: &str, params: T) -> Result<R, Self::Error>
    where
        T: Debug + Serialize + Send + Sync,
        R: DeserializeOwned,
    {
        let start = Instant::now();
        let res = self.inner.request(method, params).await;
        self.metrics
            .increment_metrics(&self.config, method, start, res.is_ok());
        res
    }
}

impl<C: JsonRpcClient + 'static> From<PrometheusJsonRpcClient<C>>
    for JsonRpcBlockGetter<PrometheusJsonRpcClient<C>>
{
    fn from(val: PrometheusJsonRpcClient<C>) -> Self {
        JsonRpcBlockGetter::new(val)
    }
}

/// Utility struct for implementing `BlockNumberGetter`
#[derive(Debug, new)]
pub struct JsonRpcBlockGetter<T: JsonRpcClient>(T);

/// RPC method for getting the latest block number
pub const BLOCK_NUMBER_RPC: &str = "eth_blockNumber";

#[async_trait]
impl<C> BlockNumberGetter for JsonRpcBlockGetter<C>
where
    C: JsonRpcClient,
{
    async fn get_block_number(&self) -> Result<u64, ChainCommunicationError> {
        let res = self
            .0
            .request(BLOCK_NUMBER_RPC, ())
            .await
            .map(|r: U64| r.as_u64())
            .map_err(Into::into)?;
        Ok(res)
    }
}
