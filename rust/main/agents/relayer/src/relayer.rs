use std::{
    collections::{HashMap, HashSet},
    fmt::{Debug, Formatter},
    hash::Hash,
    sync::Arc,
    time::Instant,
};

use async_trait::async_trait;
use derive_more::AsRef;
use eyre::Result;
use futures_util::future::try_join_all;
use tokio::{
    sync::{
        broadcast::Sender as BroadcastSender,
        mpsc::{self, Receiver as MpscReceiver, UnboundedSender},
    },
    task::JoinHandle,
};
use tokio_metrics::TaskMonitor;
use tracing::{debug, error, info, info_span, warn, Instrument};

use hyperlane_base::{
    broadcast::BroadcastMpscSender,
    cache::{LocalCache, MeteredCache, MeteredCacheConfig, OptionalCache},
    db::{HyperlaneRocksDB, DB},
    metrics::{AgentMetrics, ChainSpecificMetricsUpdater},
    settings::IndexSettings,
    AgentMetadata, BaseAgent, ChainMetrics, ContractSyncMetrics, ContractSyncer, CoreMetrics,
    HyperlaneAgentCore, RuntimeMetrics, SyncOptions,
};
use hyperlane_core::{
    rpc_clients::call_and_retry_n_times, ChainCommunicationError, ChainResult, ContractSyncCursor,
    HyperlaneDomain, HyperlaneMessage, InterchainGasPayment, MerkleTreeInsertion, QueueOperation,
    H512, U256,
};
use lander::DispatcherMetrics;

use crate::{db_loader::DbLoader, relayer::origin::Origin, server::ENDPOINT_MESSAGES_QUEUE_SIZE};
use crate::{
    db_loader::DbLoaderExt,
    merkle_tree::db_loader::{MerkleTreeDbLoader, MerkleTreeDbLoaderMetrics},
};
use crate::{
    metrics::message_submission::MessageSubmissionMetrics,
    msg::{
        blacklist::AddressBlacklist,
        db_loader::{MessageDbLoader, MessageDbLoaderMetrics},
        message_processor::{MessageProcessor, MessageProcessorMetrics},
        metadata::{
            BaseMetadataBuilder, DefaultIsmCache, IsmAwareAppContextClassifier,
            IsmCachePolicyClassifier,
        },
        pending_message::MessageContext,
    },
    server::{self as relayer_server},
    settings::{matching_list::MatchingList, RelayerSettings},
};

use destination::{Destination, FactoryError};

mod destination;
mod origin;

const CURSOR_BUILDING_ERROR: &str = "Error building cursor for origin";
const CURSOR_INSTANTIATION_ATTEMPTS: usize = 10;
const ADVANCED_LOG_META: bool = false;

#[derive(Debug, Hash, PartialEq, Eq, Clone)]
struct ContextKey {
    origin: HyperlaneDomain,
    destination: HyperlaneDomain,
}

/// A relayer agent
#[derive(AsRef)]
pub struct Relayer {
    origin_chains: HashSet<HyperlaneDomain>,
    #[as_ref]
    core: HyperlaneAgentCore,
    /// Context data for each (origin, destination) chain pair a message can be
    /// sent between
    msg_ctxs: HashMap<ContextKey, Arc<MessageContext>>,
    /// The original reference to the relayer cache
    _cache: OptionalCache<MeteredCache<LocalCache>>,
    message_whitelist: Arc<MatchingList>,
    message_blacklist: Arc<MatchingList>,
    address_blacklist: Arc<AddressBlacklist>,
    transaction_gas_limit: Option<U256>,
    skip_transaction_gas_limit_for: HashSet<u32>,
    allow_local_checkpoint_syncers: bool,
    metric_app_contexts: Vec<(MatchingList, String)>,
    max_retries: u32,
    core_metrics: Arc<CoreMetrics>,
    // TODO: decide whether to consolidate `agent_metrics` and `chain_metrics` into a single struct
    // or move them in `core_metrics`, like the validator metrics
    agent_metrics: AgentMetrics,
    chain_metrics: ChainMetrics,
    runtime_metrics: RuntimeMetrics,
    /// Tokio console server
    pub tokio_console_server: Option<console_subscriber::Server>,

    /// The origin chains and their associated structures
    origins: HashMap<HyperlaneDomain, Origin>,
    /// The destination chains and their associated structures
    destinations: HashMap<HyperlaneDomain, Destination>,
}

impl Debug for Relayer {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Relayer {{ origin_chains: {:?}, destination_chains: {:?}, message_whitelist: {:?}, message_blacklist: {:?}, address_blacklist: {:?}, transaction_gas_limit: {:?}, skip_transaction_gas_limit_for: {:?}, allow_local_checkpoint_syncers: {:?} }}",
            self.origin_chains,
            self.destinations.values(),
            self.message_whitelist,
            self.message_blacklist,
            self.address_blacklist,
            self.transaction_gas_limit,
            self.skip_transaction_gas_limit_for,
            self.allow_local_checkpoint_syncers
        )
    }
}

#[async_trait]
#[allow(clippy::unit_arg)]
impl BaseAgent for Relayer {
    const AGENT_NAME: &'static str = "relayer";

    type Settings = RelayerSettings;
    type Metadata = AgentMetadata;

    async fn from_settings(
        _agent_metadata: Self::Metadata,
        settings: Self::Settings,
        core_metrics: Arc<CoreMetrics>,
        agent_metrics: AgentMetrics,
        chain_metrics: ChainMetrics,
        runtime_metrics: RuntimeMetrics,
        tokio_console_server: console_subscriber::Server,
    ) -> Result<Self>
    where
        Self: Sized,
    {
        Self::reset_critical_errors(&settings, &chain_metrics);

        let start = Instant::now();

        let core = settings.build_hyperlane_core(core_metrics.clone());

        let mut start_entity_init = Instant::now();

        let cache_name = "relayer_cache";
        let inner_cache = if settings.allow_contract_call_caching {
            Some(MeteredCache::new(
                LocalCache::new(cache_name),
                core_metrics.cache_metrics(),
                MeteredCacheConfig {
                    cache_name: cache_name.to_owned(),
                },
            ))
        } else {
            None
        };
        let cache = OptionalCache::new(inner_cache);
        debug!(elapsed = ?start_entity_init.elapsed(), event = "initialized cache", "Relayer startup duration measurement");

        let db = DB::from_path(&settings.db)?;

        start_entity_init = Instant::now();
        let origins =
            Self::build_origins(&settings, db.clone(), core_metrics.clone(), &chain_metrics).await;
        debug!(elapsed = ?start_entity_init.elapsed(), event = "initialized origin chains", "Relayer startup duration measurement");

        start_entity_init = Instant::now();
        let dispatcher_metrics = DispatcherMetrics::new(core_metrics.registry())
            .expect("Creating dispatcher metrics is infallible");
        let destinations = Self::build_destinations(
            &settings,
            db.clone(),
            core_metrics.clone(),
            &chain_metrics,
            dispatcher_metrics,
        )
        .await;
        debug!(elapsed = ?start_entity_init.elapsed(), event = "initialized destination chains", "Relayer startup duration measurement");

        let message_whitelist = Arc::new(settings.whitelist);
        let message_blacklist = Arc::new(settings.blacklist);
        let address_blacklist = Arc::new(AddressBlacklist::new(settings.address_blacklist));
        let skip_transaction_gas_limit_for = settings.skip_transaction_gas_limit_for;
        let transaction_gas_limit = settings.transaction_gas_limit;

        info!(
            %message_whitelist,
            %message_blacklist,
            ?address_blacklist,
            ?transaction_gas_limit,
            ?skip_transaction_gas_limit_for,
            "Whitelist configuration"
        );

        start_entity_init = Instant::now();
        let mut msg_ctxs = HashMap::new();
        for (destination_domain, destination) in destinations.iter() {
            let application_operation_verifier = destination.application_operation_verifier.clone();
            let destination_chain_setup = destination.chain_conf.clone();
            let destination_mailbox = destination.mailbox.clone();
            let ccip_signer = destination.ccip_signer.clone();

            let transaction_gas_limit: Option<U256> =
                if skip_transaction_gas_limit_for.contains(&destination_domain.id()) {
                    None
                } else {
                    transaction_gas_limit
                };

            let default_ism_getter = DefaultIsmCache::new(destination_mailbox.clone());

            // only iterate through origin chains that were successfully instantiated
            for (origin_domain, origin) in origins.iter() {
                let db = &origin.database;

                let origin_chain_setup = origin.chain_conf.clone();
                let prover_sync = origin.prover_sync.clone();
                let origin_gas_payment_enforcer = origin.gas_payment_enforcer.clone();
                let validator_announce = origin.validator_announce.clone();

                // Extract optional Ethereum signer for CCIP-read authentication
                let metadata_builder = BaseMetadataBuilder::new(
                    origin_domain.clone(),
                    destination_chain_setup.clone(),
                    prover_sync,
                    validator_announce.clone(),
                    settings.allow_local_checkpoint_syncers,
                    core.metrics.clone(),
                    cache.clone(),
                    db.clone(),
                    IsmAwareAppContextClassifier::new(
                        default_ism_getter.clone(),
                        settings.metric_app_contexts.clone(),
                    ),
                    IsmCachePolicyClassifier::new(
                        default_ism_getter.clone(),
                        settings.ism_cache_configs.clone(),
                    ),
                    ccip_signer.clone(),
                    origin_chain_setup.ignore_reorg_reports,
                );

                msg_ctxs.insert(
                    ContextKey {
                        origin: origin_domain.clone(),
                        destination: destination_domain.clone(),
                    },
                    Arc::new(MessageContext {
                        destination_mailbox: destination_mailbox.clone(),
                        origin_db: Arc::new(db.clone()),
                        cache: cache.clone(),
                        metadata_builder: Arc::new(metadata_builder),
                        origin_gas_payment_enforcer,
                        transaction_gas_limit,
                        metrics: MessageSubmissionMetrics::new(
                            &core_metrics,
                            origin_domain,
                            destination_domain,
                        ),
                        application_operation_verifier: application_operation_verifier.clone(),
                    }),
                );
            }
        }
        debug!(elapsed = ?start_entity_init.elapsed(), event = "initialized message contexts", "Relayer startup duration measurement");

        debug!(elapsed = ?start.elapsed(), event = "fully initialized", "Relayer startup duration measurement");

        Ok(Self {
            _cache: cache,
            origin_chains: settings.origin_chains,
            msg_ctxs,
            core,
            message_whitelist,
            message_blacklist,
            address_blacklist,
            transaction_gas_limit,
            skip_transaction_gas_limit_for,
            allow_local_checkpoint_syncers: settings.allow_local_checkpoint_syncers,
            metric_app_contexts: settings.metric_app_contexts,
            max_retries: settings.max_retries,
            core_metrics,
            agent_metrics,
            chain_metrics,
            runtime_metrics,
            tokio_console_server: Some(tokio_console_server),
            origins,
            destinations,
        })
    }

    #[allow(clippy::async_yields_async)]
    async fn run(mut self) {
        let start = Instant::now();
        let mut start_entity_init = Instant::now();

        let mut tasks = vec![];

        let task_monitor = tokio_metrics::TaskMonitor::new();
        if let Some(tokio_console_server) = self.tokio_console_server.take() {
            let console_server = tokio::task::Builder::new()
                .name("tokio_console_server")
                .spawn(TaskMonitor::instrument(
                    &task_monitor.clone(),
                    async move {
                        info!("Starting tokio console server");
                        if let Err(e) = tokio_console_server.serve().await {
                            error!(error=?e, "Tokio console server failed to start");
                        }
                    }
                    .instrument(info_span!("Tokio console server")),
                ))
                .expect("spawning tokio task from Builder is infallible");
            tasks.push(console_server);
        }
        debug!(elapsed = ?start_entity_init.elapsed(), event = "started tokio console server", "Relayer startup duration measurement");

        let sender = BroadcastSender::new(ENDPOINT_MESSAGES_QUEUE_SIZE);
        // send channels by destination chain
        let mut send_channels = HashMap::with_capacity(self.destinations.len());
        let mut prep_queues = HashMap::with_capacity(self.destinations.len());
        start_entity_init = Instant::now();
        for (dest_domain, destination) in &self.destinations {
            let dest_conf = &destination.chain_conf;

            let (send_channel, receive_channel) = mpsc::unbounded_channel::<QueueOperation>();
            send_channels.insert(dest_domain.id(), send_channel);

            let dispatcher_entrypoint = self
                .destinations
                .get(dest_domain)
                .and_then(|d| d.dispatcher_entrypoint.clone());

            let db = match self.origins.get(dest_domain) {
                Some(origin) => origin.database.clone(),
                None => {
                    tracing::error!(domain=?dest_domain.name(), "DB missing");
                    continue;
                }
            };

            // Default to submitting one message at a time if there is no batch config
            let max_batch_size = self
                .core
                .settings
                .chains
                .get(dest_domain)
                .and_then(|chain| {
                    chain
                        .connection
                        .operation_submission_config()
                        .map(|c| c.max_batch_size)
                })
                .unwrap_or(1);
            let max_submit_queue_len =
                self.core
                    .settings
                    .chains
                    .get(dest_domain)
                    .and_then(|chain| {
                        chain
                            .connection
                            .operation_submission_config()
                            .and_then(|c| c.max_submit_queue_length)
                    });
            let message_processor = MessageProcessor::new(
                dest_domain.clone(),
                receive_channel,
                &sender,
                MessageProcessorMetrics::new(&self.core.metrics, dest_domain),
                max_batch_size,
                max_submit_queue_len,
                task_monitor.clone(),
                dispatcher_entrypoint,
                db,
            );
            prep_queues.insert(dest_domain.id(), message_processor.prepare_queue().await);

            tasks.push(self.run_destination_processor(
                dest_domain,
                message_processor,
                task_monitor.clone(),
            ));

            let dispatcher = self
                .destinations
                .get(dest_domain)
                .and_then(|d| d.dispatcher.clone());
            if let Some(dispatcher) = dispatcher {
                tasks.push(dispatcher.spawn().await);
            }

            let metrics_updater = match ChainSpecificMetricsUpdater::new(
                dest_conf,
                self.core_metrics.clone(),
                self.agent_metrics.clone(),
                self.chain_metrics.clone(),
                Self::AGENT_NAME.to_string(),
            )
            .await
            {
                Ok(task) => task,
                Err(err) => {
                    Self::record_critical_error(
                        dest_domain,
                        &self.chain_metrics,
                        &err,
                        "Failed to build metrics updater",
                    );
                    continue;
                }
            };
            tasks.push(metrics_updater.spawn());
        }
        debug!(elapsed = ?start_entity_init.elapsed(), event = "started processors", "Relayer startup duration measurement");

        start_entity_init = Instant::now();
        for (origin_domain, origin) in self.origins.iter() {
            let maybe_broadcaster = origin.message_sync.get_broadcaster();

            let message_sync = match self.run_message_sync(origin, task_monitor.clone()).await {
                Ok(task) => task,
                Err(err) => {
                    Self::record_critical_error(
                        origin_domain,
                        &self.chain_metrics,
                        &err,
                        "Failed to run message sync",
                    );
                    continue;
                }
            };
            tasks.push(message_sync);

            let interchain_gas_payment_sync = match self
                .run_interchain_gas_payment_sync(
                    origin,
                    BroadcastMpscSender::map_get_receiver(maybe_broadcaster.as_ref()).await,
                    task_monitor.clone(),
                )
                .await
            {
                Ok(task) => task,
                Err(err) => {
                    Self::record_critical_error(
                        &origin.domain,
                        &self.chain_metrics,
                        &err,
                        "Failed to run interchain gas payment sync",
                    );
                    continue;
                }
            };
            if let Some(task) = interchain_gas_payment_sync {
                tasks.push(task);
            }

            let merkle_tree_hook_sync = match self
                .run_merkle_tree_hook_sync(
                    origin,
                    BroadcastMpscSender::map_get_receiver(maybe_broadcaster.as_ref()).await,
                    task_monitor.clone(),
                )
                .await
            {
                Ok(task) => task,
                Err(err) => {
                    Self::record_critical_error(
                        origin_domain,
                        &self.chain_metrics,
                        &err,
                        "Failed to run merkle tree hook sync",
                    );
                    continue;
                }
            };
            tasks.push(merkle_tree_hook_sync);

            let message_db_loader = match self.run_message_db_loader(
                origin,
                send_channels.clone(),
                task_monitor.clone(),
            ) {
                Ok(task) => task,
                Err(err) => {
                    Self::record_critical_error(
                        origin_domain,
                        &self.chain_metrics,
                        &err,
                        "Failed to run message db loader",
                    );
                    continue;
                }
            };
            tasks.push(message_db_loader);

            let merkle_tree_db_loader =
                match self.run_merkle_tree_db_loader(origin, task_monitor.clone()) {
                    Ok(task) => task,
                    Err(err) => {
                        Self::record_critical_error(
                            origin_domain,
                            &self.chain_metrics,
                            &err,
                            "Failed to run merkle tree db loader",
                        );
                        continue;
                    }
                };
            tasks.push(merkle_tree_db_loader);
        }
        debug!(elapsed = ?start_entity_init.elapsed(), event = "started message, IGP, merkle tree hook syncs, and message and merkle tree db loader", "Relayer startup duration measurement");

        // run server
        start_entity_init = Instant::now();

        // create a db mapping for server handlers
        let dbs: HashMap<u32, HyperlaneRocksDB> = self
            .origins
            .iter()
            .map(|(origin_domain, origin)| (origin_domain.id(), origin.database.clone()))
            .chain(
                self.destinations
                    .iter()
                    .map(|(dest_domain, dest)| (dest_domain.id(), dest.database.clone())),
            )
            .collect();

        let gas_enforcers: HashMap<_, _> = self
            .msg_ctxs
            .iter()
            .map(|(key, ctx)| (key.origin.clone(), ctx.origin_gas_payment_enforcer.clone()))
            .collect();
        let relayer_router = relayer_server::Server::new(self.destinations.len())
            .with_op_retry(sender.clone())
            .with_message_queue(prep_queues)
            .with_dbs(dbs)
            .with_gas_enforcers(gas_enforcers)
            .router();

        let server = self
            .core
            .settings
            .server(self.core_metrics.clone())
            .expect("Failed to create server");
        let server_task = tokio::spawn(
            async move {
                server.run_with_custom_router(relayer_router);
            }
            .instrument(info_span!("Relayer server")),
        );
        tasks.push(server_task);
        debug!(elapsed = ?start_entity_init.elapsed(), event = "started relayer server", "Relayer startup duration measurement");

        tasks.push(self.runtime_metrics.spawn());

        debug!(elapsed = ?start.elapsed(), event = "fully started", "Relayer startup duration measurement");

        if let Err(err) = try_join_all(tasks).await {
            tracing::error!(
                error=?err,
                "Relayer task panicked"
            );
        }
    }
}

impl Relayer {
    fn record_critical_error(
        domain: &HyperlaneDomain,
        chain_metrics: &ChainMetrics,
        err: &impl Debug,
        message: &str,
    ) {
        error!(?err, domain=?domain.name(), "{message}");
        chain_metrics.set_critical_error(domain.name(), true);
    }

    async fn instantiate_cursor_with_retries<T: 'static>(
        contract_sync: Arc<dyn ContractSyncer<T>>,
        index_settings: IndexSettings,
    ) -> ChainResult<Box<dyn ContractSyncCursor<T>>> {
        call_and_retry_n_times(
            || {
                let contract_sync = contract_sync.clone();
                let index_settings = index_settings.clone();
                Box::pin(async move {
                    let cursor = contract_sync.cursor(index_settings).await?;
                    Ok(cursor)
                })
            },
            CURSOR_INSTANTIATION_ATTEMPTS,
            None,
        )
        .await
    }

    async fn run_message_sync(
        &self,
        origin: &Origin,
        task_monitor: TaskMonitor,
    ) -> eyre::Result<JoinHandle<()>> {
        let origin_domain = origin.domain.clone();
        let contract_sync = origin.message_sync.clone();

        let index_settings = origin.chain_conf.index_settings().clone();
        let chain_metrics = self.chain_metrics.clone();

        let name = Self::contract_sync_task_name("message::", origin_domain.name());
        Ok(tokio::task::Builder::new()
            .name(&name)
            .spawn(TaskMonitor::instrument(
                &task_monitor,
                async move {
                    Self::message_sync_task(
                        &origin_domain,
                        contract_sync,
                        index_settings,
                        chain_metrics,
                    )
                    .await;
                }
                .instrument(info_span!("MessageSync")),
            ))
            .expect("spawning tokio task from Builder is infallible"))
    }

    async fn message_sync_task(
        origin: &HyperlaneDomain,
        contract_sync: Arc<dyn ContractSyncer<HyperlaneMessage>>,
        index_settings: IndexSettings,
        chain_metrics: ChainMetrics,
    ) {
        let cursor_instantiation_result =
            Self::instantiate_cursor_with_retries(contract_sync.clone(), index_settings).await;
        let cursor = match cursor_instantiation_result {
            Ok(cursor) => cursor,
            Err(err) => {
                Self::record_critical_error(origin, &chain_metrics, &err, CURSOR_BUILDING_ERROR);
                return;
            }
        };
        let label = "dispatched_messages";
        contract_sync.clone().sync(label, cursor.into()).await;
        info!(chain = origin.name(), label, "contract sync task exit");
    }

    async fn run_interchain_gas_payment_sync(
        &self,
        origin: &Origin,
        tx_id_receiver: Option<MpscReceiver<H512>>,
        task_monitor: TaskMonitor,
    ) -> eyre::Result<Option<JoinHandle<()>>> {
        let contract_sync = match origin.interchain_gas_payment_sync.as_ref() {
            Some(s) => s.clone(),
            None => {
                return Ok(None);
            }
        };
        let chain_metrics = self.chain_metrics.clone();

        let origin_domain = origin.domain.clone();
        let index_settings = origin.chain_conf.index_settings().clone();

        let name = Self::contract_sync_task_name("gas_payment::", origin_domain.name());

        let handle = tokio::task::Builder::new()
            .name(&name)
            .spawn(TaskMonitor::instrument(
                &task_monitor,
                async move {
                    Self::interchain_gas_payments_sync_task(
                        &origin_domain,
                        index_settings,
                        contract_sync,
                        chain_metrics,
                        tx_id_receiver,
                    )
                    .await;
                }
                .instrument(info_span!("IgpSync")),
            ))
            .expect("spawning tokio task from Builder is infallible");
        Ok(Some(handle))
    }

    async fn interchain_gas_payments_sync_task(
        origin: &HyperlaneDomain,
        index_settings: IndexSettings,
        contract_sync: Arc<dyn ContractSyncer<InterchainGasPayment>>,
        chain_metrics: ChainMetrics,
        tx_id_receiver: Option<MpscReceiver<H512>>,
    ) {
        let cursor = match Self::instantiate_cursor_with_retries(
            contract_sync.clone(),
            index_settings.clone(),
        )
        .await
        {
            Ok(cursor) => cursor,
            Err(err) => {
                Self::record_critical_error(origin, &chain_metrics, &err, CURSOR_BUILDING_ERROR);
                return;
            }
        };
        let label = "gas_payments";
        contract_sync
            .clone()
            .sync(label, SyncOptions::new(Some(cursor), tx_id_receiver))
            .await;
        info!(chain = origin.name(), label, "contract sync task exit");
    }

    async fn run_merkle_tree_hook_sync(
        &self,
        origin: &Origin,
        tx_id_receiver: Option<MpscReceiver<H512>>,
        task_monitor: TaskMonitor,
    ) -> eyre::Result<JoinHandle<()>> {
        let chain_metrics = self.chain_metrics.clone();

        let origin_domain = origin.domain.clone();
        let index_settings = origin.chain_conf.index_settings().clone();
        let contract_sync = origin.merkle_tree_hook_sync.clone();

        let name = Self::contract_sync_task_name("merkle_tree::", origin_domain.name());
        Ok(tokio::task::Builder::new()
            .name(&name)
            .spawn(TaskMonitor::instrument(
                &task_monitor,
                async move {
                    Self::merkle_tree_hook_sync_task(
                        &origin_domain,
                        index_settings,
                        contract_sync,
                        chain_metrics,
                        tx_id_receiver,
                    )
                    .await;
                }
                .instrument(info_span!("MerkleTreeHookSync")),
            ))
            .expect("spawning tokio task from Builder is infallible"))
    }

    async fn merkle_tree_hook_sync_task(
        origin: &HyperlaneDomain,
        index_settings: IndexSettings,
        contract_sync: Arc<dyn ContractSyncer<MerkleTreeInsertion>>,
        chain_metrics: ChainMetrics,
        tx_id_receiver: Option<MpscReceiver<H512>>,
    ) {
        let cursor_instantiation_result =
            Self::instantiate_cursor_with_retries(contract_sync.clone(), index_settings.clone())
                .await;
        let cursor = match cursor_instantiation_result {
            Ok(cursor) => cursor,
            Err(err) => {
                Self::record_critical_error(origin, &chain_metrics, &err, CURSOR_BUILDING_ERROR);
                return;
            }
        };
        let label = "merkle_tree_hook";
        contract_sync
            .clone()
            .sync(label, SyncOptions::new(Some(cursor), tx_id_receiver))
            .await;
        info!(chain = origin.name(), label, "contract sync task exit");
    }

    fn contract_sync_task_name(prefix: &str, domain: &str) -> String {
        format!("contract::sync::{}{}", prefix, domain)
    }

    fn run_message_db_loader(
        &self,
        origin: &Origin,
        send_channels: HashMap<u32, UnboundedSender<QueueOperation>>,
        task_monitor: TaskMonitor,
    ) -> eyre::Result<JoinHandle<()>> {
        let metrics = MessageDbLoaderMetrics::new(
            &self.core.metrics,
            &origin.domain,
            self.destinations.keys(),
        );
        let destination_ctxs: HashMap<_, _> = self
            .destinations
            .keys()
            .filter_map(|destination| {
                let key = ContextKey {
                    origin: origin.domain.clone(),
                    destination: destination.clone(),
                };
                let context = self
                    .msg_ctxs
                    .get(&key)
                    .map(|c| (destination.id(), c.clone()));

                if context.is_none() {
                    let err_msg = format!(
                        "No message context found for origin {} and destination {}",
                        origin.domain.name(),
                        destination.name()
                    );
                    Self::record_critical_error(
                        &origin.domain,
                        &self.chain_metrics,
                        &ChainCommunicationError::CustomError(err_msg.clone()),
                        &err_msg,
                    );
                }

                context
            })
            .collect();

        let message_db_loader = MessageDbLoader::new(
            origin.database.clone(),
            self.message_whitelist.clone(),
            self.message_blacklist.clone(),
            self.address_blacklist.clone(),
            metrics,
            send_channels,
            destination_ctxs,
            self.metric_app_contexts.clone(),
            self.max_retries,
        );

        let span = info_span!("MessageDbLoader", origin=%message_db_loader.domain());
        let db_loader = DbLoader::new(Box::new(message_db_loader), task_monitor.clone());
        Ok(db_loader.spawn(span))
    }

    fn run_merkle_tree_db_loader(
        &self,
        origin: &Origin,
        task_monitor: TaskMonitor,
    ) -> eyre::Result<JoinHandle<()>> {
        let metrics = MerkleTreeDbLoaderMetrics::new(&self.core.metrics, &origin.domain);

        let merkle_tree_db_loader =
            MerkleTreeDbLoader::new(origin.database.clone(), metrics, origin.prover_sync.clone());
        let span = info_span!("MerkleTreeDbLoader", origin=%merkle_tree_db_loader.domain());
        let db_loader = DbLoader::new(Box::new(merkle_tree_db_loader), task_monitor.clone());
        Ok(db_loader.spawn(span))
    }

    #[allow(clippy::panic)]
    #[allow(clippy::too_many_arguments)]
    #[tracing::instrument(skip(self, message_processor))]
    fn run_destination_processor(
        &self,
        destination: &HyperlaneDomain,
        message_processor: MessageProcessor,
        task_monitor: TaskMonitor,
    ) -> JoinHandle<()> {
        let span = info_span!("MessageProcessor", destination=%destination);
        let destination = destination.clone();
        let name = format!("message_processor::destination::{}", destination.name());
        tokio::task::Builder::new()
            .name(&name)
            .spawn(TaskMonitor::instrument(
                &task_monitor,
                async move {
                    // Propagate task panics
                    message_processor.spawn().await.unwrap_or_else(|err| {
                        panic!(
                            "destination processor panicked for destination {}: {:?}",
                            destination, err
                        )
                    });
                }
                .instrument(span),
            ))
            .expect("spawning tokio task from Builder is infallible")
    }

    pub async fn build_origins(
        settings: &RelayerSettings,
        db: DB,
        core_metrics: Arc<CoreMetrics>,
        chain_metrics: &ChainMetrics,
    ) -> HashMap<HyperlaneDomain, Origin> {
        use origin::Factory;
        use origin::OriginFactory;

        let contract_sync_metrics = Arc::new(ContractSyncMetrics::new(&core_metrics));
        let factory = OriginFactory::new(
            db,
            core_metrics,
            contract_sync_metrics,
            ADVANCED_LOG_META,
            settings.tx_id_indexing_enabled,
            settings.igp_indexing_enabled,
        );

        let origin_futures: Vec<_> = settings
            .chains
            .iter()
            .map(|(domain, chain)| async {
                (
                    domain.clone(),
                    factory
                        .create(
                            domain.clone(),
                            chain,
                            settings.gas_payment_enforcement.clone(),
                        )
                        .await,
                )
            })
            .collect();
        let results = futures::future::join_all(origin_futures).await;
        let origins = results
            .into_iter()
            .filter_map(|(domain, result)| match result {
                Ok(origin) => Some((domain, origin)),
                Err(err) => {
                    Self::record_critical_error(
                        &domain,
                        chain_metrics,
                        &err,
                        "Critical error when building chain as origin",
                    );
                    None
                }
            })
            .collect::<HashMap<_, _>>();
        settings
            .origin_chains
            .iter()
            .filter(|domain| !origins.contains_key(domain))
            .for_each(|domain| {
                Self::record_critical_error(
                    domain,
                    chain_metrics,
                    &FactoryError::MissingConfiguration(domain.name().to_string()),
                    "Critical error when building chain as origin",
                );
            });

        origins
    }

    pub async fn build_destinations(
        settings: &RelayerSettings,
        db: DB,
        core_metrics: Arc<CoreMetrics>,
        chain_metrics: &ChainMetrics,
        dispatcher_metrics: DispatcherMetrics,
    ) -> HashMap<HyperlaneDomain, Destination> {
        use destination::DestinationFactory;
        use destination::Factory;

        let factory = DestinationFactory::new(db, core_metrics);

        let destination_futures: Vec<_> = settings
            .chains
            .iter()
            .map(|(domain, chain)| async {
                (
                    domain.clone(),
                    factory
                        .create(domain.clone(), chain.clone(), dispatcher_metrics.clone())
                        .await,
                )
            })
            .collect();
        let results = futures::future::join_all(destination_futures).await;
        let destinations = results
            .into_iter()
            .filter_map(|(domain, result)| match result {
                Ok(destination) => Some((domain, destination)),
                Err(err) => {
                    Self::record_critical_error(
                        &domain,
                        chain_metrics,
                        &err,
                        "Critical error when building chain as destination",
                    );
                    None
                }
            })
            .collect::<HashMap<_, _>>();

        settings
            .destination_chains
            .iter()
            .filter(|domain| !destinations.contains_key(domain))
            .for_each(|domain| {
                Self::record_critical_error(
                    domain,
                    chain_metrics,
                    &FactoryError::MissingConfiguration(domain.name().to_string()),
                    "Critical error when building chain as destination",
                );
            });

        destinations
    }

    fn reset_critical_errors(settings: &RelayerSettings, chain_metrics: &ChainMetrics) {
        settings
            .origin_chains
            .iter()
            .for_each(|origin| chain_metrics.set_critical_error(origin.name(), false));
    }
}

#[cfg(test)]
mod tests;
