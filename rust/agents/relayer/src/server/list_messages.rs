use axum::{
    extract::{Query, State},
    routing, Router,
};
use derive_new::new;
use hyperlane_core::QueueOperation;
use serde::Deserialize;
use std::collections::HashMap;

use crate::msg::op_queue::OperationPriorityQueue;

const LIST_MESSAGES_API_BASE: &str = "/list_messages";

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub enum ListOperationsRequest {
    DestinationDomain(u32),
}

impl PartialEq<QueueOperation> for &ListOperationsRequest {
    fn eq(&self, other: &QueueOperation) -> bool {
        match self {
            ListOperationsRequest::DestinationDomain(destination_domain) => {
                destination_domain == &other.destination_domain().id()
            }
        }
    }
}

#[derive(new, Clone)]
pub struct ListOperationsApi {
    op_queues: HashMap<u32, OperationPriorityQueue>,
}

async fn list_messages(
    State(queues): State<HashMap<u32, OperationPriorityQueue>>,
    Query(request): Query<ListOperationsRequest>,
) -> String {
    let ListOperationsRequest::DestinationDomain(domain) = request;
    let Some(op_queue) = queues.get(&domain) else {
        return format!("No queue found for domain {}", domain);
    };
    let formatted = format_queue(op_queue.clone()).await;
    formatted.join("\n")
}

pub async fn format_queue(queue: OperationPriorityQueue) -> Vec<String> {
    queue
        .lock()
        .await
        .iter()
        .map(|reverse| format!("{:?}", reverse.0))
        .collect()
}

impl ListOperationsApi {
    pub fn router(&self) -> Router {
        Router::new()
            .route("/", routing::get(list_messages))
            .with_state(self.op_queues.clone())
    }

    pub fn get_route(&self) -> (&'static str, Router) {
        (LIST_MESSAGES_API_BASE, self.router())
    }
}
