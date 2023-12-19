use axum::{
    http::{Response, StatusCode},
    routing::get,
    Router,
};
use bytes::Bytes;
use prometheus::{Encoder, Registry};
use std::{net::SocketAddr, sync::Arc};
use tokio::task::JoinHandle;
use tracing::warn;

/// A server that serves metrics in OpenMetrics format.
pub struct Server {
    listen_port: u16,
    registry: Registry,
}

impl Server {
    /// Create a new server instance.
    pub fn new(listen_port: u16, registry: Registry) -> Self {
        Self {
            listen_port,
            registry,
        }
    }

    /// Run an HTTP server serving OpenMetrics format reports on `/metrics`
    pub fn run_http_server(self: Arc<Self>) -> JoinHandle<()> {
        let port = self.listen_port;
        tracing::info!(port, "starting prometheus server on 0.0.0.0");

        let server_clone = self.clone();
        tokio::spawn(async move {
            let app = Router::new().route(
                "/metrics",
                get(move || {
                    let server = server_clone.clone();
                    async move {
                        match server.gather() {
                            Ok(metrics) => {
                                let response = Response::builder()
                                    .header("Content-Type", "text/plain; charset=utf-8")
                                    .body(Bytes::from(metrics))
                                    .unwrap();
                                Ok::<_, hyper::Error>(response)
                            }
                            Err(_) => {
                                let response = Response::builder()
                                    .status(StatusCode::NOT_FOUND)
                                    .body(Bytes::from("Failed to encode metrics"))
                                    .unwrap();
                                Ok::<_, hyper::Error>(response)
                            }
                        }
                    }
                }),
            );

            let addr = SocketAddr::from(([0, 0, 0, 0], port));
            axum::Server::bind(&addr)
                .serve(app.into_make_service())
                .await
                .expect("Failed to start server");
        })
    }

    /// Gather available metrics into an encoded (plaintext, OpenMetrics format)
    /// report.
    pub fn gather(&self) -> prometheus::Result<Vec<u8>> {
        let collected_metrics = self.registry.gather();
        let mut out_buf = Vec::with_capacity(1024 * 64);
        let encoder = prometheus::TextEncoder::new();
        encoder.encode(&collected_metrics, &mut out_buf)?;
        Ok(out_buf)
    }
}

// / Run an HTTP server serving OpenMetrics format reports on `/metrics`
// /
// / This is compatible with Prometheus, which ought to be configured to
// / scrape me!
// pub fn run_http_server(self: Arc<Self>) -> JoinHandle<()> {
//     let port = self.listen_port;
//     tracing::info!(port, "starting prometheus server on 0.0.0.0");

//     tokio::spawn(async move {
//         let app = Router::new()
//         .route("/metrics", get(move || async move {
//             let metrics = self.gather().expect("failed to encode metrics");
//             (
//                 StatusCode::OK,
//                 [("Content-Type", "text/plain; charset=utf-8")],
//                 metrics,
//             )
//         }))
//         .fallback(get_service(ServeDir::new(".")).handle_error(|error| async move {
//             (
//                 StatusCode::INTERNAL_SERVER_ERROR,
//                 format!("Unhandled internal error: {}", error),
//             )
//         }));

// })
// }

// warp::serve(
//     warp::path!("metrics")
//         .map(move || {
//             warp::reply::with_header(
//                 self.gather().expect("failed to encode metrics"),
//                 "Content-Type",
//                 // OpenMetrics specs demands "application/openmetrics-text;
//                 // version=1.0.0; charset=utf-8"
//                 // but the prometheus scraper itself doesn't seem to care?
//                 // try text/plain to make web browsers happy.
//                 "text/plain; charset=utf-8",
//             )
//         })
//         .or(warp::any().map(|| {
//             warp::reply::with_status(
//                 "go look at /metrics",
//                 warp::http::StatusCode::NOT_FOUND,
//             )
//         })),
// )
// .try_bind(([0, 0, 0, 0], port))
// .await;
