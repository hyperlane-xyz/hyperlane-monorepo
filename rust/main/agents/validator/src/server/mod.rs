pub mod eigen_node;
pub mod merkle_tree_insertions;

pub use eigen_node::EigenNodeApi;

use std::sync::Arc;

use axum::Router;

use hyperlane_base::CoreMetrics;
use hyperlane_core::HyperlaneDomain;

/// Returns a vector of validator-specific endpoint routes to be served.
/// Can be extended with additional routes and feature flags to enable/disable individually.
pub fn router(origin_chain: HyperlaneDomain, metrics: Arc<CoreMetrics>) -> Router {
    let eigen_node_api = EigenNodeApi::new(origin_chain, metrics);

    eigen_node_api.router()
}
