use axum::{http::StatusCode, response::IntoResponse, routing::get, Router};
use derive_new::new;
use std::sync::Arc;
use tokio::task::JoinHandle;

use crate::CoreMetrics;

/// A server that serves agent-specific routes
#[derive(new, Debug)]
pub struct Server {
    listen_port: u16,
    core_metrics: Arc<CoreMetrics>,
}

impl Server {
    /// Run an HTTP server
    pub fn run(self: Arc<Self>) -> JoinHandle<()> {
        self.run_with_custom_router(Router::new())
    }

    /// Run an HTTP server serving agent-specific different routes
    ///
    /// routes:
    ///  - metrics - serving OpenMetrics format reports on `/metrics`
    ///     (this is compatible with Prometheus, which ought to be configured to scrape this endpoint)
    ///  - custom_routes - additional routes to be served by the server as per the specific agent
    pub fn run_with_custom_router(self: Arc<Self>, router: Router) -> JoinHandle<()> {
        let port = self.listen_port;
        tracing::info!(port, "starting server on 0.0.0.0");

        let core_metrics_clone = self.core_metrics.clone();

        let app = Router::new()
            .route(
                "/metrics",
                get(move || Self::gather_metrics(core_metrics_clone)),
            )
            .merge(router);

        tokio::task::Builder::new()
            .name("agent::server")
            .spawn(async move {
                let url = format!("0.0.0.0:{}", port);
                let listener = tokio::net::TcpListener::bind(url)
                    .await
                    .expect("Failed to bind to TCP port");
                axum::serve(listener, app)
                    .await
                    .expect("Failed to start server");
            })
            .expect("spawning tokio task from Builder is infallible")
    }

    /// Gather available metrics into an encoded (plaintext, OpenMetrics format)
    /// report.
    async fn gather_metrics(core_metrics: Arc<CoreMetrics>) -> impl IntoResponse {
        tracing::debug!("Traversing route for /metrics endpoint for serving Prometheus metrics");
        match core_metrics.gather() {
            Ok(metrics) => {
                let metrics = match String::from_utf8(metrics) {
                    Ok(metrics_string) => metrics_string,
                    Err(_) => {
                        return (
                            StatusCode::INTERNAL_SERVER_ERROR,
                            "Internal Server Error".into(),
                        )
                    }
                };
                (StatusCode::OK, metrics)
            }
            Err(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to gather metrics".into(),
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use prometheus::{Counter, Registry};
    use reqwest;

    use super::*;

    #[tokio::test]
    async fn test_metrics_endpoint() {
        let mock_registry = Registry::new();
        let counter = Counter::new("expected_metric_content", "test123").unwrap();
        mock_registry.register(Box::new(counter.clone())).unwrap();
        counter.inc();

        let server = Server::new(
            8080,
            Arc::new(CoreMetrics::new("test", 8080, mock_registry).unwrap()),
        );
        let server = Arc::new(server);
        // Run the server in the background
        let _server_task = tokio::spawn(async move {
            server.run().await.unwrap();
        });

        tokio::time::sleep(tokio::time::Duration::from_millis(1000)).await;

        let client = reqwest::Client::new();
        let response = client
            .get("http://127.0.0.1:8080/metrics")
            .send()
            .await
            .expect("Failed to send request");
        assert!(response.status().is_success());

        let body = response.text().await.expect("Failed to read response body");
        assert!(body.contains("expected_metric_content"));
    }
}
