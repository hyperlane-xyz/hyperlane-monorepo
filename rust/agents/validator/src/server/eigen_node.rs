use crate::CoreMetrics;
use axum::{
    http::StatusCode,
    response::IntoResponse,
    routing::{get, Router},
    Json,
};
use derive_new::new;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Serialize, Deserialize)]
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

#[derive(Serialize, Deserialize)]
struct Service {
    id: String,
    name: String,
    description: String,
    status: ServiceStatus,
}

/// A server that serves EigenLayer specific routes
#[derive(new)]
pub struct EigenNodeAPI {
    core_metrics: Arc<CoreMetrics>,
}

impl EigenNodeAPI {
    /// Function to create the eigen_node_router
    pub fn router(&self) -> Router {
        let core_metrics_clone = self.core_metrics.clone();

        tracing::info!("Serving the EigenNodeAPI routes...");

        Router::new()
            .route(
                "/node/health",
                get(move || Self::node_health_handler(core_metrics_clone)),
            )
            .route("/node/services", get(Self::node_services_handler))
            .route(
                "/node/services/:service_id/health",
                get(Self::service_health_handler),
            )
            .route("/node", get(Self::node_info_handler))
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

    /// Method to return the NodeInfo data
    /// if signed_checkpoint - observed_checkpoint <= 1 return 200 - healthy
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
        if observed_checkpoint - signed_checkpoint <= 1 {
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
                status: ServiceStatus::Down,
            },
        ];
        Json(services)
    }

    /// Method to return the health of a service
    pub async fn service_health_handler(service_id: String) -> impl IntoResponse {
        // TODO: implement logic to check if the service is healthy
        // now just return 200
        format!("Health check for service: {}", service_id);
        StatusCode::OK
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;
    use prometheus::Registry;
    use serde_json::Value;

    #[tokio::test]
    async fn test_eigen_node_api() {
        let core_metrics =
            Arc::new(CoreMetrics::new("dummy_relayer", 37582, Registry::new()).unwrap());

        let node_api = EigenNodeAPI::new(core_metrics);
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
        let core_metrics = Arc::new(CoreMetrics::new("dummy_relayer", 37582, registry).unwrap());
        // Initialize the Prometheus registry
        core_metrics
            .latest_checkpoint()
            .with_label_values(&["validator_observed", "ethereum"])
            .set(42);

        let node_api = EigenNodeAPI::new(core_metrics.clone());
        let app = node_api.router();

        // Run the app in the background using a test server
        let server =
            axum::Server::bind(&"127.0.0.1:0".parse().unwrap()).serve(app.into_make_service());
        let addr = server.local_addr();
        let server_handle = tokio::spawn(server);

        // Create a client and make a request to the `/node/health` endpoint
        // if signed_checkpoint - observed_checkpoint > 10 return 503 - unhealthy
        let client = reqwest::Client::new();
        let res = client
            .get(format!("http://{}/node/health", addr))
            .send()
            .await
            .expect("Failed to send request");
        assert_eq!(res.status(), StatusCode::SERVICE_UNAVAILABLE);

        // if signed_checkpoint - observed_checkpoint <= 10 return 206 - partially healthy
        core_metrics
            .latest_checkpoint()
            .with_label_values(&["validator_processed", "ethereum"])
            .set(34);
        let res = client
            .get(format!("http://{}/node/health", addr))
            .send()
            .await
            .expect("Failed to send request");
        assert_eq!(res.status(), StatusCode::PARTIAL_CONTENT);

        // if signed_checkpoint - observed_checkpoint <= 1 return 200 - healthy
        core_metrics
            .latest_checkpoint()
            .with_label_values(&["validator_processed", "ethereum"])
            .set(42);
        let res = client
            .get(format!("http://{}/node/health", addr))
            .send()
            .await
            .expect("Failed to send request");
        assert_eq!(res.status(), StatusCode::OK);

        // Stop the server
        server_handle.abort();
    }

    #[tokio::test]
    async fn test_eigen_node_services_handler() {
        let core_metrics =
            Arc::new(CoreMetrics::new("dummy_relayer", 37582, Registry::new()).unwrap());

        let node_api = EigenNodeAPI::new(core_metrics);
        let app = node_api.router();

        // Run the app in the background using a test server
        let server =
            axum::Server::bind(&"127.0.0.1:0".parse().unwrap()).serve(app.into_make_service());
        let addr = server.local_addr();
        let server_handle = tokio::spawn(server);

        // Create a client and make a request to the `/node/services` endpoint
        let client = reqwest::Client::new();
        let res = client
            .get(format!("http://{}/node/services", addr))
            .send()
            .await
            .expect("Failed to send request");

        // Check that the response status is OK
        assert_eq!(res.status(), StatusCode::OK);

        // check the response body if needed
        let json: Value = res.json().await.expect("Failed to parse json");
        println!("{}", json);
        assert_eq!(json[0]["id"], "hyperlane-validator-indexer");
        assert_eq!(json[0]["name"], "indexer");
        assert_eq!(
            json[0]["description"],
            "indexes the messages from the origin chain mailbox"
        );
        assert_eq!(json[0]["status"], "Up");

        assert_eq!(json[1]["id"], "hyperlane-validator-submitter");
        assert_eq!(json[1]["name"], "submitter");
        assert_eq!(
            json[1]["description"],
            "signs messages indexed from the indexer"
        );
        assert_eq!(json[1]["status"], "Down");

        // Stop the server
        server_handle.abort();
    }

    #[tokio::test]
    async fn test_service_health_handler() {
        let core_metrics =
            Arc::new(CoreMetrics::new("dummy_relayer", 37582, Registry::new()).unwrap());

        let node_api = EigenNodeAPI::new(core_metrics);
        let app = node_api.router();
        let server =
            axum::Server::bind(&"127.0.0.1:0".parse().unwrap()).serve(app.into_make_service());
        let addr = server.local_addr();
        let server_handle = tokio::spawn(server);

        let client = reqwest::Client::new();
        let res = client
            .get(format!(
                "http://{}/node/services/hyperlane-validator-indexer/health",
                addr
            ))
            .send()
            .await
            .expect("Failed to send request");

        // Check that the response status is OK
        assert_eq!(res.status(), StatusCode::OK);

        // Stop the server
        server_handle.abort();
    }
}
