//! A wrapper around a JsonRpcClient to give insight at the request level. This
//! was designed specifically for use with the quorum provider.
use std::{fmt::Debug, time::Instant};

use derive_builder::Builder;
use maplit::hashmap;
use prometheus::{CounterVec, IntCounterVec};
use serde::{Deserialize, Serialize};
use url::Url;

use crate::utils::url_to_host_info;

/// Expected label names for the metric.
pub const PROVIDER_CREATE_COUNT_LABELS: &[&str] = &["chain"];
/// Help string for the metric.
pub const PROVIDER_CREATE_COUNT_HELP: &str =
    "Total number of times this provider was instantiated by this client";

/// Expected label names for the metric.
pub const PROVIDER_DROP_COUNT_LABELS: &[&str] = &["chain"];
/// Help string for the metric.
pub const PROVIDER_DROP_COUNT_HELP: &str =
    "Total number of times this provider was dropped by this client";

/// Expected label names for the metric.
pub const REQUEST_COUNT_LABELS: &[&str] =
    &["provider_node", "connection", "chain", "method", "status"];
/// Help string for the metric.
pub const REQUEST_COUNT_HELP: &str = "Total number of requests made to this client";

/// Expected label names for the metric.
pub const REQUEST_DURATION_SECONDS_LABELS: &[&str] =
    &["provider_node", "connection", "chain", "method", "status"];
/// Help string for the metric.
pub const REQUEST_DURATION_SECONDS_HELP: &str = "Total number of seconds spent making requests";

/// Container for all the relevant rpc client metrics.
#[derive(Clone, Builder, Default)]
pub struct PrometheusClientMetrics {
    /// Total number of providers being created.
    /// - `chain`: chain name (or chain id if the name is unknown) of the chain
    ///   the request was made on.
    #[builder(setter(into, strip_option), default)]
    pub provider_create_count: Option<IntCounterVec>,

    /// Total number of providers being dropped.
    /// - `chain`: chain name (or chain id if the name is unknown) of the chain
    ///   the request was made on.
    #[builder(setter(into, strip_option), default)]
    pub provider_drop_count: Option<IntCounterVec>,

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
    pub fn increment_provider_instance(&self, chain: &str) {
        let labels = hashmap! {
            "chain" => chain,
        };
        if let Some(counter) = &self.provider_create_count {
            counter.with(&labels).inc();
        }
    }
    pub fn decrement_provider_instance(&self, chain: &str) {
        let labels = hashmap! {
            "chain" => chain,
        };
        if let Some(counter) = &self.provider_drop_count {
            counter.with(&labels).inc();
        }
    }

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
            "connection" => config.connection_type.as_str(),
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

/// Just so we can derive Debug for other structs that use this
impl std::fmt::Debug for PrometheusClientMetrics {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "PrometheusClientMetrics")
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

#[derive(Clone, Copy, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ClientConnectionType {
    #[default]
    Rpc,
    Grpc,
}

impl ClientConnectionType {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Grpc => "grpc",
            Self::Rpc => "rpc",
        }
    }
}

/// Configuration for the prometheus JsonRpcClioent. This can be loaded via
/// serde.
#[derive(Default, Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub struct PrometheusConfig {
    pub connection_type: ClientConnectionType,
    /// Information about what node this client is connecting to.
    pub node: Option<NodeInfo>,

    /// Information about the chain this client is for.
    pub chain: Option<ChainInfo>,
}

impl PrometheusConfig {
    pub fn from_url(
        url: &Url,
        connection_type: ClientConnectionType,
        chain: Option<ChainInfo>,
    ) -> Self {
        Self {
            connection_type,
            node: Some(NodeInfo {
                host: url_to_host_info(url),
            }),
            chain,
        }
    }

    pub fn chain_name(chain_info: &Option<ChainInfo>) -> &str {
        chain_info
            .as_ref()
            .and_then(|c| c.name.as_ref())
            .map(|n| n.as_str())
            .unwrap_or("unknown")
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
        PrometheusConfig::chain_name(&self.chain)
    }
}

#[cfg(test)]
mod tests {
    use url::Url;

    use super::{ChainInfo, ClientConnectionType, PrometheusConfig, PrometheusConfigExt};

    #[test]
    fn test_node_host() {
        let urls = [
            "https://rpc.example.com/1235/1243243",
            "https://grpc.example.com:5432/123453",
            "https://grpc.abc.com",
            "https://abcd.efg.higk.example.xyz:443",
            "grpc.example.com:443",
            "grpc2.example.com:234/chain/12345",
            "grpc3.example.com:234/",
        ];

        let expected = [
            "rpc.example.com:443",
            "grpc.example.com:5432",
            "grpc.abc.com:443",
            "abcd.efg.higk.example.xyz:443",
            "grpc.example.com:443",
            "grpc2.example.com:234",
            "grpc3.example.com:234",
        ];

        for (url, expected) in urls.into_iter().zip(expected.into_iter()) {
            let url = Url::parse(url).expect("Failed to parse URL");
            let config = PrometheusConfig::from_url(
                &url,
                ClientConnectionType::Rpc,
                Some(ChainInfo {
                    name: Some("neutron".to_string()),
                }),
            );

            let actual = config.node_host();
            assert_eq!(actual, expected);
        }
    }
}
