// TODO: `rustc` 1.80.1 clippy issue
#![allow(clippy::doc_lazy_continuation)]
//! A server that serves EigenLayer specific routes
//! compliant with the spec here https://eigen.nethermind.io/docs/spec/api/
//!
//! Base URL /eigen
//! Routes
//! - /node - Node Info
//!   eg. response {"node_name":"Hyperlane Validator","spec_version":"0.1.0","node_version":"0.1.0"}
//! - /node/health - Node Health
//!  eg. response 200 - healthy, 206 - partially healthy, 503 - unhealthy
//! - /node/services - List of Services
//!  eg. response [{"id":"hyperlane-validator-indexer","name":"indexer","description":"indexes the messages from the origin chain mailbox","status":"up"},{"id":"hyperlane-validator-submitter","name":"submitter","description":"signs messages indexed from the indexer","status":"up"}]
//! - /node/services/{service_id}/health - Service Health
//! eg. response 200 - healthy, 503 - unhealthy

use axum::{
    http::StatusCode,
    response::IntoResponse,
    routing::{get, Router},
    Json,
};
use derive_new::new;
use hyperlane_base::CoreMetrics;
use hyperlane_core::HyperlaneDomain;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

const EIGEN_NODE_API_BASE: &str = "/eigen";

#[derive(Serialize, Deserialize, PartialEq, Debug)]
enum ServiceStatus {
    Up,
    Down,
    Initializing,
}

#[derive(Serialize, Deserialize, PartialEq, Debug)]
struct NodeInfo {
    node_name: String,
    spec_version: String,
    node_version: String,
}

#[derive(Serialize, Deserialize, PartialEq, Debug)]
struct Service {
    id: String,
    name: String,
    description: String,
    status: ServiceStatus,
}

#[derive(new)]
pub struct EigenNodeApi {
    origin_chain: HyperlaneDomain,
    core_metrics: Arc<CoreMetrics>,
}

impl EigenNodeApi {
    pub fn router(&self) -> Router {
        let core_metrics_clone = self.core_metrics.clone();
        let origin_chain = self.origin_chain.clone();

        tracing::info!("Serving the EigenNodeAPI routes...");

        let health_route = get(move || {
            Self::node_health_handler(origin_chain.clone(), core_metrics_clone.clone())
        });

        let router = Router::new()
            .route("/health", health_route)
            .route("/services", get(Self::node_services_handler))
            .route(
                "/services/{service_id}/health",
                get(Self::service_health_handler),
            )
            .route("/", get(Self::node_info_handler));

        let node_router = Router::new().nest("/node", router);

        Router::new().nest(EIGEN_NODE_API_BASE, node_router)
    }

    pub async fn node_info_handler() -> impl IntoResponse {
        let node_info = NodeInfo {
            node_name: "Hyperlane Validator".to_string(),
            spec_version: "0.1.0".to_string(),
            node_version: "0.1.0".to_string(),
        };
        Json(node_info)
    }

    /// Method to return the NodeInfo data
    /// if signed_checkpoint - observed_checkpoint <= 1 return 200 - healthy
    /// else if observed_checkpoint - signed_checkpoint <= 10 return 203 - partially healthy
    /// else return 503 - unhealthy
    pub async fn node_health_handler(
        origin_chain: HyperlaneDomain,
        core_metrics: Arc<CoreMetrics>,
    ) -> impl IntoResponse {
        let checkpoint_delta = core_metrics.get_latest_checkpoint_validator_delta(origin_chain);

        // logic to check if the node is healthy
        if checkpoint_delta <= 1 {
            // 200 - healthy
            StatusCode::OK
        } else if checkpoint_delta <= 10 {
            // 206 - partially healthy
            StatusCode::PARTIAL_CONTENT
        } else {
            // 503 - unhealthy
            StatusCode::SERVICE_UNAVAILABLE
        }
    }

    /// Method to return a list of services
    /// NB: hardcoded for now
    pub async fn node_services_handler() -> impl IntoResponse {
        let services = vec![
            Service {
                id: "hyperlane-validator-indexer".to_string(),
                name: "indexer".to_string(),
                description: "indexes the messages from the origin chain mailbox".to_string(),
                status: ServiceStatus::Up,
            },
            Service {
                id: "hyperlane-validator-submitter".to_string(),
                name: "submitter".to_string(),
                description: "signs messages indexed from the indexer".to_string(),
                status: ServiceStatus::Up,
            },
        ];
        Json(services)
    }

    /// Method to return the health of a service
    pub async fn service_health_handler(_service_id: String) -> impl IntoResponse {
        // TODO: implement logic to check if the service is healthy
        // now just return 200
        StatusCode::OK
    }
}

#[cfg(test)]
mod tests {
    use crate::test_utils::request::parse_body_to_json;

    use super::*;
    use axum::{
        body::Body,
        http::{Method, Request, StatusCode},
    };
    use prometheus::Registry;
    use tower::ServiceExt;

    const PARTIALLY_HEALTHY_OBSERVED_CHECKPOINT: i64 = 34;
    const HEALTHY_OBSERVED_CHECKPOINT: i64 = 42;

    #[derive(Debug)]
    struct TestServerSetup {
        pub app: Router,
        pub core_metrics: Arc<CoreMetrics>,
    }

    fn setup_test_server() -> TestServerSetup {
        let core_metrics =
            Arc::new(CoreMetrics::new("dummy_validator", 37582, Registry::new()).unwrap());
        // Initialize the Prometheus registry
        core_metrics
            .latest_checkpoint()
            .with_label_values(&["validator_observed", "ethereum"])
            .set(HEALTHY_OBSERVED_CHECKPOINT);

        let node_api = EigenNodeApi::new(
            HyperlaneDomain::new_test_domain("ethereum"),
            Arc::clone(&core_metrics),
        );
        let app = node_api.router();

        TestServerSetup { app, core_metrics }
    }

    #[tokio::test]
    async fn test_eigen_node_api() {
        let TestServerSetup { app, .. } = setup_test_server();

        let api_url = format!("{EIGEN_NODE_API_BASE}/node");
        let request = Request::builder()
            .uri(api_url)
            .method(Method::GET)
            .body(Body::empty())
            .expect("Failed to build request");
        let response = app.oneshot(request).await.expect("Failed to send request");

        // Check that the response status is OK
        assert_eq!(response.status(), StatusCode::OK);

        // what to expect when you're expecting
        let expected = NodeInfo {
            node_name: "Hyperlane Validator".to_string(),
            spec_version: "0.1.0".to_string(),
            node_version: "0.1.0".to_string(),
        };

        // check the response body if needed
        let json: NodeInfo = parse_body_to_json(response.into_body()).await;
        assert_eq!(json, expected);
    }

    #[tokio::test]
    async fn test_eigen_node_health_api() {
        let TestServerSetup { app, core_metrics } = setup_test_server();

        let api_url = format!("{EIGEN_NODE_API_BASE}/node/health");
        let request = Request::builder()
            .uri(api_url)
            .method(Method::GET)
            .body(Body::empty())
            .expect("Failed to build request");
        let response = app
            .clone()
            .oneshot(request)
            .await
            .expect("Failed to send request");
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);

        core_metrics
            .latest_checkpoint()
            .with_label_values(&["validator_processed", "ethereum"])
            .set(PARTIALLY_HEALTHY_OBSERVED_CHECKPOINT);

        let api_url = format!("{EIGEN_NODE_API_BASE}/node/health");
        let request = Request::builder()
            .uri(api_url)
            .method(Method::GET)
            .body(Body::empty())
            .expect("Failed to build request");
        let response = app
            .clone()
            .oneshot(request)
            .await
            .expect("Failed to send request");
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);

        core_metrics
            .latest_checkpoint()
            .with_label_values(&["validator_processed", "ethereum"])
            .set(HEALTHY_OBSERVED_CHECKPOINT);

        let api_url = format!("{EIGEN_NODE_API_BASE}/node/health");
        let request = Request::builder()
            .uri(api_url)
            .method(Method::GET)
            .body(Body::empty())
            .expect("Failed to build request");
        let response = app
            .clone()
            .oneshot(request)
            .await
            .expect("Failed to send request");
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_eigen_node_services_handler() {
        let TestServerSetup { app, .. } = setup_test_server();

        let api_url = format!("{EIGEN_NODE_API_BASE}/node/services");
        let request = Request::builder()
            .uri(api_url)
            .method(Method::GET)
            .body(Body::empty())
            .expect("Failed to build request");
        let response = app
            .clone()
            .oneshot(request)
            .await
            .expect("Failed to send request");
        assert_eq!(response.status(), StatusCode::OK);

        let expected_services = vec![
            Service {
                id: "hyperlane-validator-indexer".to_string(),
                name: "indexer".to_string(),
                description: "indexes the messages from the origin chain mailbox".to_string(),
                status: ServiceStatus::Up,
            },
            Service {
                id: "hyperlane-validator-submitter".to_string(),
                name: "submitter".to_string(),
                description: "signs messages indexed from the indexer".to_string(),
                status: ServiceStatus::Up,
            },
        ];
        let services: Vec<Service> = parse_body_to_json(response.into_body()).await;
        assert_eq!(services, expected_services);
    }

    #[tokio::test]
    async fn test_service_health_handler() {
        let TestServerSetup { app, .. } = setup_test_server();

        let api_url =
            format!("{EIGEN_NODE_API_BASE}/node/services/hyperlane-validator-indexer/health");
        let request = Request::builder()
            .uri(api_url)
            .method(Method::GET)
            .body(Body::empty())
            .expect("Failed to build request");
        let response = app
            .clone()
            .oneshot(request)
            .await
            .expect("Failed to send request");
        // Check that the response status is OK
        assert_eq!(response.status(), StatusCode::OK);
    }
}
