use axum::Router;
use derive_new::new;
use std::collections::HashMap;
use std::env;
use tokio::sync::broadcast::Sender;

use crate::msg::op_queue::OperationPriorityQueue;

pub const ENDPOINT_MESSAGES_QUEUE_SIZE: usize = 100;

use crate::server::environment_variable::EnvironmentVariableApi;

pub mod environment_variable;
pub mod list_messages;
pub mod message_retry;

#[derive(new)]
pub struct Server {
    destination_chains: usize,
    #[new(default)]
    retry_transmitter: Option<Sender<message_retry::MessageRetryRequest>>,
    #[new(default)]
    op_queues: Option<HashMap<u32, OperationPriorityQueue>>,
}

impl Server {
    pub fn with_op_retry(
        mut self,
        transmitter: Sender<message_retry::MessageRetryRequest>,
    ) -> Self {
        self.retry_transmitter = Some(transmitter);
        self
    }

    pub fn with_message_queue(mut self, op_queues: HashMap<u32, OperationPriorityQueue>) -> Self {
        self.op_queues = Some(op_queues);
        self
    }

    // return a custom router that can be used in combination with other routers
    pub fn router(self) -> Router {
        let mut router = Router::new();

        if let Some(tx) = self.retry_transmitter {
            router =
                router.merge(message_retry::ServerState::new(tx, self.destination_chains).router())
        }
        if let Some(op_queues) = self.op_queues {
            router = router.merge(list_messages::ServerState::new(op_queues).router());
        }

        let expose_environment_variable_endpoint =
            env::var("HYPERLANE_RELAYER_ENVIRONMENT_VARIABLE_ENDPOINT_ENABLED")
                .map_or(false, |v| v == "true");
        if expose_environment_variable_endpoint {
            router = router.merge(EnvironmentVariableApi::new().router());
        }
        router
    }
}
