use std::collections::HashMap;
use std::env;
use std::sync::{Arc, RwLock as StdRwLock};

use axum::Router;
use derive_new::new;
use tokio::sync::broadcast::Sender;
use tokio::sync::RwLock;

use hyperlane_base::db::HyperlaneRocksDB;
use hyperlane_core::{HyperlaneDomain, HyperlaneMessage, Indexer};
use lander::CommandEntrypoint;

use crate::merkle_tree::builder::MerkleTreeBuilder;
use crate::msg::gas_payment::GasPaymentEnforcer;
use crate::msg::op_queue::OperationPriorityQueue;
use crate::msg::pending_message::MessageContext;
use crate::relay_api::handlers::TxHashCache;

use crate::server::environment_variable::EnvironmentVariableApi;
use hyperlane_core::QueueOperation;
use tokio::sync::mpsc::UnboundedSender;

pub const ENDPOINT_MESSAGES_QUEUE_SIZE: usize = 100;

pub mod environment_variable;
pub mod evm;
pub mod igp;
pub mod merkle_tree_insertions;
pub mod messages;
pub mod operations;
pub mod proofs;

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
    #[new(default)]
    // (origin, destination)
    msg_ctxs: HashMap<(u32, u32), Arc<MessageContext>>,
    #[new(default)]
    prover_syncs: Option<HashMap<u32, Arc<RwLock<MerkleTreeBuilder>>>>,
    #[new(default)]
    dispatcher_command_entrypoints: Option<HashMap<u32, Arc<dyn CommandEntrypoint>>>,
    #[new(default)]
    relay_send_channels: Option<HashMap<u32, UnboundedSender<QueueOperation>>>,
    #[new(default)]
    relay_indexers: Option<HashMap<String, Arc<dyn Indexer<HyperlaneMessage>>>>,
    #[new(default)]
    relay_tx_hash_cache: Option<Arc<StdRwLock<TxHashCache>>>,
    #[new(default)]
    relay_api_metrics: Option<crate::relay_api::RelayApiMetrics>,
    #[new(default)]
    relay_rate_limiter: Option<Arc<StdRwLock<crate::relay_api::handlers::RateLimiter>>>,
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

    pub fn with_msg_ctxs(mut self, msg_ctxs: HashMap<(u32, u32), Arc<MessageContext>>) -> Self {
        self.msg_ctxs = msg_ctxs;
        self
    }

    pub fn with_prover_sync(
        mut self,
        prover_syncs: HashMap<u32, Arc<RwLock<MerkleTreeBuilder>>>,
    ) -> Self {
        self.prover_syncs = Some(prover_syncs);
        self
    }

    pub fn with_dispatcher_command_entrypoints(
        mut self,
        entrypoints: HashMap<u32, Arc<dyn CommandEntrypoint>>,
    ) -> Self {
        self.dispatcher_command_entrypoints = Some(entrypoints);
        self
    }

    pub fn with_relay_send_channels(
        mut self,
        channels: HashMap<u32, UnboundedSender<QueueOperation>>,
    ) -> Self {
        self.relay_send_channels = Some(channels);
        self
    }

    pub fn with_indexers(
        mut self,
        indexers: HashMap<String, Arc<dyn Indexer<HyperlaneMessage>>>,
    ) -> Self {
        self.relay_indexers = Some(indexers);
        self
    }

    pub fn with_tx_hash_cache(mut self, cache: Arc<StdRwLock<TxHashCache>>) -> Self {
        self.relay_tx_hash_cache = Some(cache);
        self
    }

    pub fn with_relay_api_metrics(mut self, metrics: crate::relay_api::RelayApiMetrics) -> Self {
        self.relay_api_metrics = Some(metrics);
        self
    }

    pub fn with_rate_limiter(
        mut self,
        limiter: Arc<StdRwLock<crate::relay_api::handlers::RateLimiter>>,
    ) -> Self {
        self.relay_rate_limiter = Some(limiter);
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
            router = router
                .merge(operations::list_messages::ServerState::new(op_queues.clone()).router());
            if let Some(dbs) = self.dbs.as_ref() {
                router = router.merge(
                    operations::reprocess_message::ServerState::new(
                        dbs.clone(),
                        op_queues.clone(),
                        self.msg_ctxs.clone(),
                    )
                    .router(),
                );
            }
        }
        if let Some(dbs) = self.dbs.as_ref() {
            router = router
                .merge(messages::ServerState::new(dbs.clone()).router())
                .merge(merkle_tree_insertions::ServerState::new(dbs.clone()).router());
        }
        if let Some(gas_enforcers) = self.gas_enforcers {
            router = router.merge(igp::ServerState::new(gas_enforcers.clone()).router());
        }
        if let Some(prover_syncs) = self.prover_syncs {
            router = router.merge(proofs::ServerState::new(prover_syncs).router());
        }
        if let Some(chains) = self.dispatcher_command_entrypoints {
            router = router.merge(evm::nonce::ServerState::new(chains).router());
        }

        let expose_environment_variable_endpoint =
            env::var("HYPERLANE_RELAYER_ENVIRONMENT_VARIABLE_ENDPOINT_ENABLED")
                .is_ok_and(|v| v == "true");
        if expose_environment_variable_endpoint {
            router = router.merge(EnvironmentVariableApi::new().router());
        }

        // Add relay API
        if let (Some(dbs), Some(indexers), Some(send_channels)) = (
            self.dbs.as_ref(),
            self.relay_indexers,
            self.relay_send_channels.as_ref(),
        ) {
            let mut relay_state = crate::relay_api::handlers::ServerState::new()
                .with_indexers(indexers)
                .with_dbs(dbs.clone())
                .with_send_channels(send_channels.clone())
                .with_msg_ctxs(self.msg_ctxs.clone());

            // Add tx hash cache if available
            if let Some(cache) = self.relay_tx_hash_cache {
                relay_state = relay_state.with_tx_hash_cache(cache);
            }

            // Add metrics if available
            if let Some(metrics) = self.relay_api_metrics {
                relay_state = relay_state.with_metrics(metrics);
            }

            // Add rate limiter if available
            if let Some(limiter) = self.relay_rate_limiter {
                relay_state = relay_state.with_rate_limiter(limiter);
            }

            router = router.merge(relay_state.router());
        }

        router
    }
}
