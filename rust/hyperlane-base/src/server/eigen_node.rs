use axum::{
    routing::{get, Router},
    Json,
    response::IntoResponse
};
use crate::CoreMetrics;
use std::sync::{Weak, Arc};
use serde::Serialize;

// Define a struct for the data you want to return for eigen/node
#[derive(Serialize)]
struct NodeInfo {
    node_name: String,
    spec_version: String,
    node_version: String,
}

pub struct EigenNodeAPI {
    core_metrics: Weak<CoreMetrics>,
}

impl EigenNodeAPI {
    /// Create a new instance of the EigenNodeAPI
    pub fn new(core_metrics: Arc<CoreMetrics>) -> Self {
        let core_metrics_weak = Arc::downgrade(&core_metrics);
        Self { core_metrics: core_metrics_weak }
    }

    /// Function to create the eigen_node_router
    pub fn router(&self) -> Router {
        let health_api = self.clone();

        Router::new()
        .route("/node/health", get(move || health_api.clone().node_health_handler()))
        .route("/node", get(Self::node_info_handler))
    }

    /// Method to return the NodeInfo data
    pub async fn node_health_handler(&self) -> impl IntoResponse {
        // let latest_checkpoint = self.core_metrics.latest_checkpoint().get_metric_with_label_values(&[/* appropriate labels */])
        //     .map(|g| g.get())
        //     .unwrap_or(0.0);
        if let Some(core_metrics) = self.core_metrics.upgrade() {
            let latest_checkpoint = core_metrics.last_known_message_nonce()
                .get_metric_with_label_values(&["your", "label", "values"])
                .map(|g| g.get())
                .unwrap_or(0);
            println!("latest_checkpoint: {}", latest_checkpoint);

            // StatusCode::OK
        }

        let node_info = NodeInfo {
            node_name: "Hyperlane Validator".to_string(),
            spec_version: "0.1.0".to_string(),
            node_version: "0.1.0".to_string(),
        };
        Json(node_info)
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

    // pub set_node_info() 

}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;
    use prometheus::Registry;
    use serde_json::Value;

    #[tokio::test]
    async fn test_eigen_node_api() {
        
        let core_metrics = CoreMetrics::new("dummy_relayer", 37582, Registry::new()).unwrap();

        let node_api = EigenNodeAPI::new(Arc::new(core_metrics));
        let app = node_api.router();

        // Run the app in the background using a test server
        let server = axum::Server::bind(&"127.0.0.1:0".parse().unwrap())
            .serve(app.into_make_service());
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

        // Optionally, check the response body if needed
        let json: Value = res.json().await.expect("Failed to parse json");
        assert_eq!(json["node_name"], "Hyperlane Validator");
        assert_eq!(json["spec_version"], "0.1.0");
        assert_eq!(json["node_version"], "0.1.0");

        // Stop the server
        server_handle.abort();
    }

    // #[tokio::test]
    // async fn test_eigen_node_api_internal_error() {
    //     // Setup the test environment to induce an error in get_node_info
    //     // For example, set a global variable or use a feature flag
    //     // ...

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
    //     // ...

    //     // Stop the server
    //     server_handle.abort();
    // }
}


