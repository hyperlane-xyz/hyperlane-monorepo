use crate::server::eigen_node::EigenNodeAPI;
use axum::routing::Router;
use hyperlane_base::CoreMetrics; // Add missing import statement
use hyperlane_core::HyperlaneDomain;
use std::sync::Arc;

pub struct ValidatorServer {
    pub routes: Vec<(&'static str, Router)>,
}

impl ValidatorServer {
    // add routes for servering EigenLayer specific routes compliant with the spec here https://eigen.nethermind.io/docs/spec/api/
    pub fn new(origin_chain: HyperlaneDomain, metrics: Arc<CoreMetrics>) -> Self {
        let mut routes = vec![];
        let eigen_node_api = EigenNodeAPI::new(origin_chain, metrics);
        routes.push(("/eigen", eigen_node_api.router()));

        Self { routes }
    }
}
