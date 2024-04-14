pub mod eigen_node;
use std::{sync::Arc, vec};

use axum::Router;
pub use eigen_node::EigenNodeApi;

use hyperlane_base::CoreMetrics;
use hyperlane_core::HyperlaneDomain;

/// Returns a vector of validator-specific endpoint routes to be served.
/// Can be extended with additional routes and feature flags to enable/disable individually.
pub fn routes(
    origin_chain: HyperlaneDomain,
    metrics: Arc<CoreMetrics>,
) -> Vec<(&'static str, Router)> {
    let eigen_node_api = EigenNodeApi::new(origin_chain, metrics);

    vec![eigen_node_api.get_route()]
}
