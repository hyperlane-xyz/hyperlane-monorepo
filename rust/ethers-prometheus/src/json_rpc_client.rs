//! A wrapper around a JsonRpcClient to give insight at the request level. This
//! was designed specifically for use with the quorum provider.

use std::fmt::{Debug, Formatter};
use std::time::Instant;

use async_trait::async_trait;
use derive_builder::Builder;
use ethers::prelude::JsonRpcClient;
use maplit::hashmap;
use prometheus::{CounterVec, IntCounterVec};
use serde::de::DeserializeOwned;
use serde::Serialize;

/// Container for all the relevant rpc client metrics.
#[derive(Clone, Builder)]
pub struct JsonRpcClientMetrics {
    /// Total number of requests made to this client.
    /// - `node`: node this is connecting to, e.g. `alchemy.com`,
    ///   `quicknode.pro`, or `localhost:8545`.
    /// - `chain`: chain name (or chain id if the name is unknown) of the chain
    ///   the request was made on.
    /// - `method`: request method string.
    #[builder(setter(into, strip_option), default)]
    request_count: Option<IntCounterVec>,

    /// Total number of requests made which resulted in an error from the inner
    /// client.
    /// - `node`: node this is connecting to, e.g. `alchemy.com`,
    ///   `quicknode.pro`, or `localhost:8545`.
    /// - `chain`: chain name (or chain id if the name is unknown) of the chain
    ///   the request was made on.
    /// - `method`: request method string.
    #[builder(setter(into, strip_option), default)]
    request_failure_count: Option<IntCounterVec>,

    /// Total number of seconds spent making requests.
    /// - `node`: node this is connecting to, e.g. `alchemy.com`,
    ///   `quicknode.pro`, or `localhost:8545`.
    /// - `chain`: chain name (or chain id if the name is unknown) of the chain
    ///   the request was made on.
    /// - `method`: request method string.
    #[builder(setter(into, strip_option), default)]
    request_duration_seconds: Option<CounterVec>,
}

/// Expected label names for the metric.
pub const REQUEST_COUNT_LABELS: &[&str] = &["node", "chain", "method"];
/// Help string for the metric.
pub const REQUEST_COUNT_HELP: &str = "Total number of requests made to this client";

/// Expected label names for the metric.
pub const REQUEST_FAILURE_COUNT_LABELS: &[&str] = &["node", "chain", "method"];
/// Help string for the metric.
pub const REQUEST_FAILURE_COUNT_HELP: &str =
    "Total number of requests made which resulted in an error from the inner client";

/// Expected label names for the metric.
pub const REQUEST_DURATION_SECONDS_LABELS: &[&str] = &["node", "chain", "method"];
/// Help string for the metric.
pub const REQUEST_DURATION_SECONDS_HELP: &str = "Total number of seconds spent making requests";

/// An ethers-rs JsonRpcClient wrapper that instruments requests with prometheus
/// metrics. To make this as flexible as possible, the metric vecs need to be
/// created and named externally, they should follow the naming convention here
/// and must include the described labels.
#[derive(Builder)]
pub struct PrometheusJsonRpcClient<C> {
    inner: C,
    metrics: JsonRpcClientMetrics,
    /// Name of the node this is connecting to, e.g. `alchemy.com`,
    /// `quicknode.pro`, or `localhost:8545`.
    node: String,
    /// chain name (or chain id if the name is unknown) of the chain the
    /// provider is for.
    chain: String,
}

impl<C> Debug for PrometheusJsonRpcClient<C>
where
    C: JsonRpcClient,
{
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(f, "PrometheusJsonRpcClient({:?})", self.inner)
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
        let labels = hashmap! {
            "node" => self.node.as_str(),
            "chain" => self.chain.as_str(),
            "method" => method
        };
        let start = Instant::now();
        let res = self.inner.request(method, params).await;
        if let Some(counter) = &self.metrics.request_failure_count {
            if res.is_err() {
                counter.with(&labels).inc()
            }
        }
        if let Some(counter) = &self.metrics.request_count {
            counter.with(&labels).inc()
        }
        if let Some(counter) = &self.metrics.request_duration_seconds {
            counter
                .with(&labels)
                .inc_by((Instant::now() - start).as_secs_f64())
        };
        res
    }
}
