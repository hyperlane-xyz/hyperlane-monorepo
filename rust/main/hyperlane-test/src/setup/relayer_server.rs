use axum::Router;
use prometheus::IntGaugeVec;
use std::net::SocketAddr;

pub fn dummy_metrics_and_label() -> (IntGaugeVec, String) {
    (
        IntGaugeVec::new(
            prometheus::Opts::new("op_queue", "OpQueue metrics"),
            &[
                "destination",
                "queue_metrics_label",
                "operation_status",
                "app_context",
            ],
        )
        .unwrap(),
        "queue_metrics_label".to_string(),
    )
}

pub fn spawn_server(path: &str, router: Router) -> SocketAddr {
    let app = Router::new().nest(path, router);

    // Running the app in the background using a test server
    let server = axum::Server::bind(&"127.0.0.1:0".parse().unwrap()).serve(app.into_make_service());
    let addr = server.local_addr();
    tokio::spawn(server);
    addr
}
