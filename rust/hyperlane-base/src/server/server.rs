use crate::{server::EigenNodeAPI, CoreMetrics};
use axum::{http::StatusCode, response::IntoResponse, routing::get, Router};
use derive_new::new;
use std::{net::SocketAddr, sync::Arc};
use tokio::task::JoinHandle;
use tracing::warn;

/// A server that serves agent-specific routes
#[derive(new, Debug)]
pub struct Server {
    listen_port: u16,
    core_metrics: Arc<CoreMetrics>,
}

impl Server {
    /// Run an HTTP server serving agent-specific different routes
    ///
    /// routes:
    ///   - metrics - serving OpenMetrics format reports on `/metrics`
    ///     (this is compatible with Prometheus, which ought to be configured to scrape this endpoint)
    ///  - eigen - serving agent-specific routes on `/eigen`
    pub fn run(self: Arc<Self>, enable_eigen_api: bool) -> JoinHandle<()> {
        let port = self.listen_port;
        tracing::info!(port, "starting prometheus server on 0.0.0.0");

        let core_metrics_clone = self.core_metrics.clone();

        let app = Router::new().route(
            "/metrics",
            get(move || Self::gather_metrics(core_metrics_clone)),
        );

        // conditionally nest the eigen API under /eigen
        let app = if enable_eigen_api {
            app.nest(
                "/eigen",
                EigenNodeAPI::new(self.core_metrics.clone()).router(),
            )
        } else {
            app
        };

        // let eigen_router = EigenNodeAPI::router();
        tokio::spawn(async move {
            let addr = SocketAddr::from(([0, 0, 0, 0], port));
            axum::Server::bind(&addr)
                .serve(app.into_make_service())
                .await
                .expect("Failed to start server");
            warn!("Prometheus server could not be started or exited early");
        })
    }

    /// Gather available metrics into an encoded (plaintext, OpenMetrics format)
    /// report.
    async fn gather_metrics(core_metrics: Arc<CoreMetrics>) -> impl IntoResponse {
        match core_metrics.gather() {
            Ok(metrics) => {
                let metrics =
                    String::from_utf8(metrics).unwrap_or_else(|_| "Invalid UTF-8 sequence".into());
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
    // use hyper::server;
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
        let _run_server = server.run();

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
