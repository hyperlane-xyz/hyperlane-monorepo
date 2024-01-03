use crate::CoreMetrics;
use axum::{
    response::IntoResponse,
    routing::{get, Router},
    Json,
};
use hyper::StatusCode;
use serde::Serialize;
use std::sync::Arc;

#[derive(Serialize)]
enum ServiceStatus {
    Up,
    Down,
    Initializing,
}

// Define a struct for the data you want to return for eigen/node
#[derive(Serialize)]
struct NodeInfo {
    node_name: String,
    spec_version: String,
    node_version: String,
}

#[derive(Serialize)]
struct Service {
    id: String,
    name: String,
    description: String,
    status: ServiceStatus,
}

pub struct EigenNodeAPI {
    core_metrics: Arc<CoreMetrics>,
}

impl EigenNodeAPI {
    /// Create a new instance of the EigenNodeAPI
    pub fn new(core_metrics: Arc<CoreMetrics>) -> Self {
        // let core_metrics_weak = Arc::downgrade(&core_metrics);
        Self { core_metrics }
    }

    /// Function to create the eigen_node_router
    pub fn router(&self) -> Router {
        // let health_api_clone = self.clone();
        let core_metrics_clone = self.core_metrics.clone();

        Router::new()
            .route(
                "/node/health",
                get(move || Self::node_health_handler(core_metrics_clone)),
            )
            .route("/node/services", get(Self::node_services_handler))
            .route("/node", get(Self::node_info_handler))
    }

    /// Method to return the NodeInfo data
    /// if signed_checkpoint == observed_checkpoint return 200 - healthy
    /// else if observed_checkpoint - signed_checkpoint <= 10 return 203 - partially healthy
    /// else return 503 - unhealthy
    pub async fn node_health_handler(core_metrics: Arc<CoreMetrics>) -> impl IntoResponse {
        let observed_checkpoint = core_metrics
            .latest_checkpoint()
            .with_label_values(&["validator_observed", "ethereum"])
            .get();
        println!("latest_checkpoint: {}", observed_checkpoint);
        let signed_checkpoint = core_metrics
            .latest_checkpoint()
            .with_label_values(&["validator_processed", "ethereum"])
            .get();

        // logic to check if the node is healthy
        if observed_checkpoint == signed_checkpoint {
            // 200 - healthy
            StatusCode::OK
        } else if observed_checkpoint - signed_checkpoint <= 10 {
            // 206 - partially healthy
            StatusCode::PARTIAL_CONTENT
        } else {
            // 503 - unhealthy
            StatusCode::SERVICE_UNAVAILABLE
        }
    }

    /// Method to return a list of services
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
                status: ServiceStatus::Down,
            },
        ];
        Json(services)
    }

    /// Method to return the NodeInfo data
    pub async fn node_info_handler() -> impl IntoResponse {
        let node_info = NodeInfo {
            node_name: "Hyperlane Validator".to_string(),
            spec_version: "0.1.0".to_string(),
            node_version: "0.1.0".to_string(),
        };
        Json(node_info)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;
    use prometheus::{IntGaugeVec, Opts, Registry};
    use serde_json::Value;

    #[tokio::test]
    async fn test_eigen_node_api() {
        let core_metrics = CoreMetrics::new("dummy_relayer", 37582, Registry::new()).unwrap();

        let node_api = EigenNodeAPI::new(Arc::new(core_metrics));
        let app = node_api.router();

        // Run the app in the background using a test server
        let server =
            axum::Server::bind(&"127.0.0.1:0".parse().unwrap()).serve(app.into_make_service());
        let addr = server.local_addr();
        let server_handle = tokio::spawn(server);

        // Create a client and make a request to the `/node` endpoint
        let client = reqwest::Client::new();
        let res = client
            .get(format!("http://{}/node", addr))
            .send()
            .await
            .expect("Failed to send request");

        // Check that the response status is OK
        assert_eq!(res.status(), StatusCode::OK);

        // check the response body if needed
        let json: Value = res.json().await.expect("Failed to parse json");
        assert_eq!(json["node_name"], "Hyperlane Validator");
        assert_eq!(json["spec_version"], "0.1.0");
        assert_eq!(json["node_version"], "0.1.0");

        // Stop the server
        server_handle.abort();
    }

    #[tokio::test]
    async fn test_eigen_node_health_api() {
        let registry = Registry::new();
        // Setup CoreMetrics and EigenNodeAPI
        let core_metrics = CoreMetrics::new("dummy_relayer", 37582, registry).unwrap();
        // Initialize the Prometheus registry

        // Create and register your metrics including 'latest_checkpoint'
        // let latest_checkpoint_metric = IntGaugeVec::new(
        //     Opts::new("latest_checkpoint", "Description"),
        //     &["phase", "chain"],
        // )
        // .unwrap();
        // registry
        //     .register(Box::new(latest_checkpoint_metric.clone()))
        //     .unwrap();
        // Set a specific value for the latest_checkpoint metric
        core_metrics
            .latest_checkpoint()
            .with_label_values(&["validator_observed", "ethereum"])
            .set(42);

        println!(
            "Set latest_checkpoint: {}",
            core_metrics
                .latest_checkpoint()
                .with_label_values(&["validator_observed", "ethereum"])
                .get()
        );

        let node_api = EigenNodeAPI::new(Arc::new(core_metrics));
        let app = node_api.router();

        // Run the app in the background using a test server
        let server =
            axum::Server::bind(&"127.0.0.1:0".parse().unwrap()).serve(app.into_make_service());
        let addr = server.local_addr();
        let server_handle = tokio::spawn(server);

        // Create a client and make a request to the `/node/health` endpoint
        let client = reqwest::Client::new();
        let res = client
            .get(format!("http://{}/node/health", addr))
            .send()
            .await
            .expect("Failed to send request");

        // Check that the response status is as expected
        assert_eq!(res.status(), StatusCode::OK);

        // check the response body if needed
        // let json: Value = res.json().await.expect("Failed to parse json");
        // assert_eq!(json["node_name"], "Hyperlane Validator");

        // Stop the server
        server_handle.abort();
    }

    // #[tokio::test]
    // async fn test_eigen_node_api_internal_error() {
    //     // Setup the test environment to induce an error in get_node_info
    //     // For example, set a global variable or use a feature flag

    //     let app = EigenNodeAPI::router();

    //     // Run the app in the background using a test server
    //     let server = axum::Server::bind(&"127.0.0.1:0".parse().unwrap())
    //         .serve(app.into_make_service());
    //     let addr = server.local_addr();
    //     let server_handle = tokio::spawn(server);

    //     // Create a client and make a request to the `/node` endpoint
    //     let client = reqwest::Client::new();
    //     let res = client
    //         .get(format!("http://{}/node", addr))
    //         .send()
    //         .await
    //         .expect("Failed to send request");

    //     // Check that the response status is 500 Internal Server Error

    //     // Optionally, check the response body for the error message
    //     // let json: Value = res.json().await.expect("Failed to parse json");
    //     // assert_eq!(json["error"], "Internal Server Error");

    //     // Clean up the test environment if necessary

    //     // Stop the server
    //     server_handle.abort();
    // }
}
