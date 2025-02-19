//! A wrapper around a JsonRpcClient to give insight at the request level. This
//! was designed specifically for use with the quorum provider.
use std::{fmt::Debug, time::Instant};

use derive_builder::Builder;
use maplit::hashmap;
use prometheus::{CounterVec, IntCounterVec};
use serde::Deserialize;
use url::Url;

use crate::utils::url_to_host_info;

/// Expected label names for the metric.
pub const REQUEST_COUNT_LABELS: &[&str] = &["provider_node", "chain", "method", "status"];
/// Help string for the metric.
pub const REQUEST_COUNT_HELP: &str = "Total number of requests made to this client";

/// Expected label names for the metric.
pub const REQUEST_DURATION_SECONDS_LABELS: &[&str] =
    &["provider_node", "chain", "method", "status"];
/// Help string for the metric.
pub const REQUEST_DURATION_SECONDS_HELP: &str = "Total number of seconds spent making requests";

/// Container for all the relevant rpc client metrics.
#[derive(Clone, Builder, Default)]
pub struct PrometheusClientMetrics {
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

impl PrometheusClientMetrics {
    /// Update prometheus metrics
    pub fn increment_metrics(
        &self,
        config: &PrometheusConfig,
        method: &str,
        start: Instant,
        success: bool,
    ) {
        let labels = hashmap! {
            "provider_node" => config.node_host(),
            "chain" => config.chain_name(),
            "method" => method,
            "status" => if success { "success" } else { "failure" },
        };
        if let Some(counter) = &self.request_count {
            counter.with(&labels).inc()
        }
        if let Some(counter) = &self.request_duration_seconds {
            counter
                .with(&labels)
                .inc_by((Instant::now() - start).as_secs_f64())
        };
    }
}

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

/// Configuration for the prometheus JsonRpcClioent. This can be loaded via
/// serde.
#[derive(Default, Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub struct PrometheusConfig {
    /// Information about what node this client is connecting to.
    pub node: Option<NodeInfo>,

    /// Information about the chain this client is for.
    pub chain: Option<ChainInfo>,
}

impl PrometheusConfig {
    pub fn from_url(url: &Url, chain: Option<ChainInfo>) -> Self {
        Self {
            node: Some(NodeInfo {
                host: url_to_host_info(url),
            }),
            chain,
        }
    }
}

/// Helper functions for displaying node and chain information
pub trait PrometheusConfigExt {
    /// The "host" part of the URL this node is connecting to. E.g.
    /// `avalanche.api.onfinality.io`.
    fn node_host(&self) -> &str;
    /// Chain name this RPC client is connected to.
    fn chain_name(&self) -> &str;
}

impl PrometheusConfigExt for PrometheusConfig {
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
