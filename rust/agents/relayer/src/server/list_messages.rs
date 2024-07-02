use axum::{
    extract::{Query, State},
    routing, Router,
};
use derive_new::new;
use hyperlane_core::QueueOperation;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;

use crate::msg::op_queue::OperationPriorityQueue;

const LIST_OPERATIONS_API_BASE: &str = "/list_operations";

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct ListOperationsRequest {
    destination_domain: u32,
}

impl PartialEq<QueueOperation> for &ListOperationsRequest {
    fn eq(&self, other: &QueueOperation) -> bool {
        self.destination_domain == other.destination_domain().id()
    }
}

#[derive(new, Clone)]
pub struct ListOperationsApi {
    op_queues: HashMap<u32, OperationPriorityQueue>,
}

async fn list_operations(
    State(queues): State<HashMap<u32, OperationPriorityQueue>>,
    Query(request): Query<ListOperationsRequest>,
) -> String {
    let domain = request.destination_domain;
    let Some(op_queue) = queues.get(&domain) else {
        return format!("No queue found for domain {}", domain);
    };
    format_queue(op_queue.clone()).await
}

pub async fn format_queue(queue: OperationPriorityQueue) -> String {
    let res: Result<Vec<Value>, _> = queue
        .lock()
        .await
        .iter()
        .map(|reverse| serde_json::to_value(&reverse.0))
        .collect();
    match res.and_then(|v| serde_json::to_string_pretty(&v)) {
        Ok(s) => s,
        Err(e) => format!("Error formatting queue: {}", e),
    }
}

impl ListOperationsApi {
    pub fn router(&self) -> Router {
        Router::new()
            .route("/", routing::get(list_operations))
            .with_state(self.op_queues.clone())
    }

    pub fn get_route(&self) -> (&'static str, Router) {
        (LIST_OPERATIONS_API_BASE, self.router())
    }
}

// TODO: there's some duplication between the setup for these tests and the one in `message_retry.rs`,
// which should be refactored into a common test setup.
#[cfg(test)]
mod tests {
    use crate::msg::op_queue::{
        test::{dummy_metrics_and_label, MockPendingOperation},
        OpQueue,
    };

    use super::*;
    use axum::http::StatusCode;
    use hyperlane_core::KnownHyperlaneDomain;
    use std::{cmp::Reverse, net::SocketAddr, sync::Arc};
    use tokio::sync::{self, Mutex};

    const DUMMY_DOMAIN: KnownHyperlaneDomain = KnownHyperlaneDomain::Arbitrum;

    fn setup_test_server() -> (SocketAddr, OperationPriorityQueue) {
        let (metrics, queue_metrics_label) = dummy_metrics_and_label();
        let broadcaster = sync::broadcast::Sender::new(100);
        let op_queue = OpQueue::new(
            metrics.clone(),
            queue_metrics_label.clone(),
            Arc::new(Mutex::new(broadcaster.subscribe())),
        );
        let mut op_queues_map = HashMap::new();
        op_queues_map.insert(DUMMY_DOMAIN as u32, op_queue.queue.clone());

        let list_operations_api = ListOperationsApi::new(op_queues_map);
        let (path, router) = list_operations_api.get_route();
        let app = Router::new().nest(path, router);

        // Running the app in the background using a test server
        let server =
            axum::Server::bind(&"127.0.0.1:0".parse().unwrap()).serve(app.into_make_service());
        let addr = server.local_addr();
        tokio::spawn(server);

        (addr, op_queue.queue.clone())
    }

    #[tokio::test]
    async fn test_message_id_retry() {
        let (addr, op_queue) = setup_test_server();
        let dummy_operation_1 =
            Box::new(MockPendingOperation::new(1, DUMMY_DOMAIN.into())) as QueueOperation;
        let dummy_operation_2 =
            Box::new(MockPendingOperation::new(2, DUMMY_DOMAIN.into())) as QueueOperation;
        let v = vec![
            serde_json::to_value(&dummy_operation_1).unwrap(),
            serde_json::to_value(&dummy_operation_2).unwrap(),
        ];
        let expected_response = serde_json::to_string_pretty(&v).unwrap();
        op_queue.lock().await.push(Reverse(dummy_operation_1));
        op_queue.lock().await.push(Reverse(dummy_operation_2));

        // Send a GET request to the server
        let response = reqwest::get(format!(
            "http://{}{}?destination_domain={}",
            addr, LIST_OPERATIONS_API_BASE, DUMMY_DOMAIN as u32
        ))
        .await
        .unwrap();

        // Check that the response status code is OK
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.text().await.unwrap(), expected_response);
    }
}
