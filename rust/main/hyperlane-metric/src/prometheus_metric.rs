//! A wrapper around a JsonRpcClient to give insight at the request level. This
//! was designed specifically for use with the quorum provider.
use std::fmt::Debug;

use derive_builder::Builder;
use prometheus::{CounterVec, IntCounterVec};
use serde::Deserialize;

/// Some basic information about a chain.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub struct ChainInfo {
    /// A human-friendly name for the chain. This should be a short string like
    /// "kovan".
    pub name: Option<String>,
}

/// Some basic information about a node.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub struct NodeInfo {
    /// The host of the node, e.g. `alchemy.com`, `quicknode.pro`, or
    /// `localhost:8545`.
    pub host: Option<String>,
}

/// Container for all the relevant rpc client metrics.
#[derive(Clone, Builder)]
pub struct JsonRpcClientMetrics {
    /// Total number of requests made to this client.
    /// - `provider_node`: node this is connecting to, e.g. `alchemy.com`,
    ///   `quicknode.pro`, or `localhost:8545`.
    /// - `chain`: chain name (or chain id if the name is unknown) of the chain
    ///   the request was made on.
    /// - `method`: request method string.
    /// - `status`: `success` or `failure` depending on the response. A `success`
    ///   might still be an "error" but not one with the transport layer.
    #[builder(setter(into, strip_option), default)]
    pub request_count: Option<IntCounterVec>,

    /// Total number of seconds spent making requests.
    /// - `provider_node`: node this is connecting to, e.g. `alchemy.com`,
    ///   `quicknode.pro`, or `localhost:8545`.
    /// - `chain`: chain name (or chain id if the name is unknown) of the chain
    ///   the request was made on.
    /// - `method`: request method string.
    /// - `status`: `success` or `failure` depending on the response. A `success`
    ///   might still be an "error" but not one with the transport layer.
    #[builder(setter(into, strip_option), default)]
    pub request_duration_seconds: Option<CounterVec>,
}

/// Expected label names for the metric.
pub const REQUEST_COUNT_LABELS: &[&str] = &["provider_node", "chain", "method", "status"];
/// Help string for the metric.
pub const REQUEST_COUNT_HELP: &str = "Total number of requests made to this client";

/// Expected label names for the metric.
pub const REQUEST_DURATION_SECONDS_LABELS: &[&str] =
    &["provider_node", "chain", "method", "status"];
/// Help string for the metric.
pub const REQUEST_DURATION_SECONDS_HELP: &str = "Total number of seconds spent making requests";

/// Configuration for the prometheus JsonRpcClioent. This can be loaded via
/// serde.
#[derive(Default, Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub struct PrometheusJsonRpcClientConfig {
    /// Information about what node this client is connecting to.
    pub node: Option<NodeInfo>,

    /// Information about the chain this client is for.
    pub chain: Option<ChainInfo>,
}

/// Helper functions for displaying node and chain information
pub trait PrometheusJsonRpcClientConfigExt {
    /// The "host" part of the URL this node is connecting to. E.g.
    /// `avalanche.api.onfinality.io`.
    fn node_host(&self) -> &str;
    /// Chain name this RPC client is connected to.
    fn chain_name(&self) -> &str;
}

impl PrometheusJsonRpcClientConfigExt for PrometheusJsonRpcClientConfig {
    fn node_host(&self) -> &str {
        self.node
            .as_ref()
            .and_then(|n| n.host.as_ref())
            .map(|h| h.as_str())
            .unwrap_or("unknown")
    }
    fn chain_name(&self) -> &str {
        self.chain
            .as_ref()
            .and_then(|c| c.name.as_ref())
            .map(|n| n.as_str())
            .unwrap_or("unknown")
    }
}
