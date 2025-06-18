use std::collections::HashMap;
use std::env;
use std::sync::Arc;

use axum::Router;
use derive_new::new;
use hyperlane_core::HyperlaneDomain;
use tokio::sync::broadcast::Sender;

use hyperlane_base::db::HyperlaneRocksDB;
use tokio::sync::RwLock;

use crate::msg::gas_payment::GasPaymentEnforcer;
use crate::msg::op_queue::OperationPriorityQueue;
use crate::server::environment_variable::EnvironmentVariableApi;

pub const ENDPOINT_MESSAGES_QUEUE_SIZE: usize = 100;

pub mod environment_variable;
pub mod igp;
pub mod merkle_tree_insertions;
pub mod messages;
pub mod operations;

#[derive(new)]
pub struct Server {
    destination_chains: usize,
    #[new(default)]
    retry_transmitter: Option<Sender<operations::message_retry::MessageRetryRequest>>,
    #[new(default)]
    op_queues: Option<HashMap<u32, OperationPriorityQueue>>,
    #[new(default)]
    dbs: Option<HashMap<u32, HyperlaneRocksDB>>,
    #[new(default)]
    gas_enforcers: Option<HashMap<HyperlaneDomain, Arc<RwLock<GasPaymentEnforcer>>>>,
}

impl Server {
    pub fn with_op_retry(
        mut self,
        transmitter: Sender<operations::message_retry::MessageRetryRequest>,
    ) -> Self {
        self.retry_transmitter = Some(transmitter);
        self
    }

    pub fn with_message_queue(mut self, op_queues: HashMap<u32, OperationPriorityQueue>) -> Self {
        self.op_queues = Some(op_queues);
        self
    }

    pub fn with_dbs(mut self, db: HashMap<u32, HyperlaneRocksDB>) -> Self {
        self.dbs = Some(db);
        self
    }

    pub fn with_gas_enforcers(
        mut self,
        gas_enforcers: HashMap<HyperlaneDomain, Arc<RwLock<GasPaymentEnforcer>>>,
    ) -> Self {
        self.gas_enforcers = Some(gas_enforcers);
        self
    }

    // return a custom router that can be used in combination with other routers
    pub fn router(self) -> Router {
        let mut router = Router::new();

        if let Some(tx) = self.retry_transmitter {
            router = router.merge(
                operations::message_retry::ServerState::new(tx, self.destination_chains).router(),
            )
        }
        if let Some(op_queues) = self.op_queues {
            router = router.merge(operations::list_messages::ServerState::new(op_queues).router());
        }
        if let Some(dbs) = self.dbs {
            router = router
                .merge(messages::ServerState::new(dbs.clone()).router())
                .merge(merkle_tree_insertions::ServerState::new(dbs.clone()).router())
        }
        if let Some(gas_enforcers) = self.gas_enforcers {
            router = router.merge(igp::ServerState::new(gas_enforcers.clone()).router())
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
