use axum::Router;
use derive_new::new;
use std::collections::HashMap;
use std::env;
use tokio::sync::broadcast::Sender;

use crate::msg::op_queue::OperationPriorityQueue;

pub const ENDPOINT_MESSAGES_QUEUE_SIZE: usize = 100;

pub use list_messages::*;
pub use message_retry::*;

use crate::server::environment_variable::EnvironmentVariableApi;

mod environment_variable;
mod list_messages;
mod message_retry;

#[derive(new)]
pub struct Server {
    destination_chains: usize,
    #[new(default)]
    retry_transmitter: Option<Sender<MessageRetryRequest>>,
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
        if let Some(tx) = self.retry_transmitter {
            routes.push(MessageRetryApi::new(tx, self.destination_chains).get_route());
        }
        if let Some(op_queues) = self.op_queues {
            routes.push(ListOperationsApi::new(op_queues).get_route());
        }

        let expose_environment_variable_endpoint =
            env::var("HYPERLANE_RELAYER_ENVIRONMENT_VARIABLE_ENDPOINT_ENABLED")
                .map_or(false, |v| v == "true");
        if expose_environment_variable_endpoint {
            routes.push(EnvironmentVariableApi::new().get_route());
        }

        routes
    }
}
