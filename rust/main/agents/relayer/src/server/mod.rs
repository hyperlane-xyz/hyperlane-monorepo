use axum::Router;
use derive_new::new;
use std::{collections::HashMap, sync::Arc};
use tokio::sync::{broadcast::Sender, mpsc, Mutex};

use crate::msg::op_queue::OperationPriorityQueue;

pub const ENDPOINT_MESSAGES_QUEUE_SIZE: usize = 100;

pub use list_messages::*;
pub use message_retry::*;

mod list_messages;
mod message_retry;

#[derive(new)]
pub struct Server {
    #[new(default)]
    retry_transmitter: Option<Sender<MessageRetryRequest>>,
    retry_receiver: Option<mpsc::Receiver<MessageRetryResponse>>,
    #[new(default)]
    op_queues: Option<HashMap<u32, OperationPriorityQueue>>,
}

impl Server {
    pub fn with_op_retry(mut self, transmitter: Sender<MessageRetryRequest>) -> Self {
        self.retry_transmitter = Some(transmitter);
        self
    }

    pub fn with_message_queue(mut self, op_queues: HashMap<u32, OperationPriorityQueue>) -> Self {
        self.op_queues = Some(op_queues);
        self
    }

    /// Returns a vector of agent-specific endpoint routes to be served.
    /// Can be extended with additional routes and feature flags to enable/disable individually.
    pub fn routes(self) -> Vec<(&'static str, Router)> {
        let mut routes = vec![];
        if let (Some(tx), Some(rx)) = (self.retry_transmitter, self.retry_receiver) {
            routes.push(MessageRetryApi::new(tx, Arc::new(Mutex::new(rx))).get_route());
        }
        if let Some(op_queues) = self.op_queues {
            routes.push(ListOperationsApi::new(op_queues).get_route());
        }

        routes
    }
}
