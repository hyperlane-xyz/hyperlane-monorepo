use std::{
    collections::{HashMap, HashSet},
    fmt::{Debug, Formatter},
    future::Future,
    hash::Hash,
    pin::Pin,
    sync::Arc,
    time::{Duration, Instant},
};

use async_trait::async_trait;
use axum::Router;
use derive_more::AsRef;
use eyre::Result;
use futures_util::future::{select_all, try_join_all};
use tokio::{
    sync::{
        broadcast::Sender as BroadcastSender,
        mpsc::{self, Receiver as MpscReceiver, UnboundedSender},
        Mutex, RwLock,
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
    HyperlaneDomain, HyperlaneMessage, InterchainGasPayment, MerkleTreeInsertion, PendingOperation,
    QueueOperation, H512, U256,
};
use lander::{CommandEntrypoint, DispatcherMetrics};

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
            BaseMetadataBuilder, DefaultIsmCache, IsmAwareAppContextClassifier, IsmCacheConfig,
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

/// Maximum number of retry attempts for chain initialization during startup
const CHAIN_INIT_MAX_RETRIES: u32 = 10;
/// Base delay between chain initialization retries (with exponential backoff)
const CHAIN_INIT_RETRY_BASE_DELAY: Duration = Duration::from_secs(5);

#[derive(Debug, Hash, PartialEq, Eq, Clone)]
struct ContextKey {
    origin: HyperlaneDomain,
    destination: HyperlaneDomain,
}

/// Dynamic chain maps that can be updated at runtime as chains become ready.
///
/// # Lock Ordering
/// When acquiring multiple locks, always acquire in this order to prevent deadlocks:
/// 1. `origins`
/// 2. `destinations`
/// 3. `msg_ctxs`
/// 4. `send_channels`
/// 5. `prep_queues`
type DynamicOrigins = Arc<RwLock<HashMap<HyperlaneDomain, Origin>>>;
type DynamicDestinations = Arc<RwLock<HashMap<HyperlaneDomain, Destination>>>;
type DynamicMessageContexts = Arc<RwLock<HashMap<ContextKey, Arc<MessageContext>>>>;

#[derive(AsRef)]
pub struct Relayer {
    origin_chains: HashSet<HyperlaneDomain>,
    #[as_ref]
    core: HyperlaneAgentCore,
    msg_ctxs: DynamicMessageContexts,
    _cache: OptionalCache<MeteredCache<LocalCache>>,
    message_whitelist: Arc<MatchingList>,
    message_blacklist: Arc<MatchingList>,
    address_blacklist: Arc<AddressBlacklist>,
    transaction_gas_limit: Option<U256>,
    skip_transaction_gas_limit_for: HashSet<u32>,
    allow_local_checkpoint_syncers: bool,
    metric_app_contexts: Vec<(MatchingList, String)>,
    ism_cache_configs: Vec<IsmCacheConfig>,
    max_retries: u32,
    core_metrics: Arc<CoreMetrics>,
    agent_metrics: AgentMetrics,
    chain_metrics: ChainMetrics,
    runtime_metrics: RuntimeMetrics,
    pub tokio_console_server: Option<console_subscriber::Server>,

    origins: DynamicOrigins,
    destinations: DynamicDestinations,

    pending_chain_init: Mutex<Option<PendingChainInit>>,
}

struct PendingChainInit {
    origin_futures: Vec<OriginInitFuture>,
    destination_futures: Vec<DestinationInitFuture>,
}

type OriginInitFuture = Pin<
    Box<
        dyn Future<Output = (HyperlaneDomain, Result<Origin, origin::FactoryError>)>
            + Send
            + 'static,
    >,
>;
type DestinationInitFuture = Pin<
    Box<
        dyn Future<
                Output = (
                    HyperlaneDomain,
                    Result<Destination, destination::FactoryError>,
                ),
            > + Send
            + 'static,
    >,
>;

impl Debug for Relayer {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Relayer {{ origin_chains: {:?}, message_whitelist: {:?}, message_blacklist: {:?}, address_blacklist: {:?}, transaction_gas_limit: {:?}, skip_transaction_gas_limit_for: {:?}, allow_local_checkpoint_syncers: {:?} }}",
            self.origin_chains,
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
        let dispatcher_metrics = DispatcherMetrics::new(core_metrics.registry())
            .expect("Creating dispatcher metrics is infallible");

        let (initial_origins, pending_origin_futures, initial_destinations, pending_dest_futures) =
            Self::build_chains_incrementally(
                &settings,
                db.clone(),
                core_metrics.clone(),
                &chain_metrics,
                dispatcher_metrics,
                settings.initial_chain_readiness_timeout,
            )
            .await?;

        debug!(
            elapsed = ?start_entity_init.elapsed(),
            initial_origins = initial_origins.len(),
            pending_origins = pending_origin_futures.len(),
            initial_destinations = initial_destinations.len(),
            pending_destinations = pending_dest_futures.len(),
            "Incremental chain initialization complete"
        );

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
        let msg_ctxs = Self::build_message_contexts(
            initial_origins.iter(),
            initial_destinations.iter(),
            &skip_transaction_gas_limit_for,
            transaction_gas_limit,
            settings.allow_local_checkpoint_syncers,
            &core.metrics,
            &cache,
            &settings.metric_app_contexts,
            &settings.ism_cache_configs,
            &core_metrics,
        );
        debug!(elapsed = ?start_entity_init.elapsed(), event = "initialized message contexts", "Relayer startup duration measurement");

        debug!(elapsed = ?start.elapsed(), event = "fully initialized", "Relayer startup duration measurement");

        let pending_chain_init = Mutex::new(
            if pending_origin_futures.is_empty() && pending_dest_futures.is_empty() {
                None
            } else {
                Some(PendingChainInit {
                    origin_futures: pending_origin_futures,
                    destination_futures: pending_dest_futures,
                })
            },
        );

        Ok(Self {
            _cache: cache,
            origin_chains: settings.origin_chains,
            msg_ctxs: Arc::new(RwLock::new(msg_ctxs)),
            core,
            message_whitelist,
            message_blacklist,
            address_blacklist,
            transaction_gas_limit,
            skip_transaction_gas_limit_for,
            allow_local_checkpoint_syncers: settings.allow_local_checkpoint_syncers,
            metric_app_contexts: settings.metric_app_contexts,
            ism_cache_configs: settings.ism_cache_configs,
            max_retries: settings.max_retries,
            core_metrics,
            agent_metrics,
            chain_metrics,
            runtime_metrics,
            tokio_console_server: Some(tokio_console_server),
            origins: Arc::new(RwLock::new(initial_origins)),
            destinations: Arc::new(RwLock::new(initial_destinations)),
            pending_chain_init,
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
        let send_channels: Arc<RwLock<HashMap<u32, UnboundedSender<QueueOperation>>>> =
            Arc::new(RwLock::new(HashMap::new()));
        let prep_queues: Arc<RwLock<PrepQueue>> = Arc::new(RwLock::new(HashMap::new()));

        start_entity_init = Instant::now();
        {
            let destinations = self.destinations.read().await;
            let origins = self.origins.read().await;
            for (dest_domain, destination) in destinations.iter() {
                let dest_tasks = self
                    .spawn_destination_tasks(
                        dest_domain,
                        destination,
                        &origins,
                        &sender,
                        send_channels.clone(),
                        prep_queues.clone(),
                        task_monitor.clone(),
                    )
                    .await;
                tasks.extend(dest_tasks);
            }
        }
        debug!(elapsed = ?start_entity_init.elapsed(), event = "started processors", "Relayer startup duration measurement");

        start_entity_init = Instant::now();
        {
            let origins = self.origins.read().await;
            let send_channels_read = send_channels.read().await;
            for (origin_domain, origin) in origins.iter() {
                let origin_tasks = self
                    .spawn_origin_tasks(
                        origin_domain,
                        origin,
                        &send_channels_read,
                        task_monitor.clone(),
                    )
                    .await;
                tasks.extend(origin_tasks);
            }
        }
        debug!(elapsed = ?start_entity_init.elapsed(), event = "started message, IGP, merkle tree hook syncs, and message and merkle tree db loader", "Relayer startup duration measurement");

        if let Some(pending_init) = self.pending_chain_init.lock().await.take() {
            let background_task = self.spawn_background_chain_init(
                pending_init,
                sender.clone(),
                send_channels.clone(),
                prep_queues.clone(),
                task_monitor.clone(),
            );
            tasks.push(background_task);
        }

        start_entity_init = Instant::now();
        // NOTE: The router is built once at startup using a snapshot of currently-ready chains.
        // Chains that initialize in the background after startup won't have HTTP endpoints
        // (retry, status, dispatcher commands) until a restart. This is an acceptable tradeoff
        // for faster startup - the relayer will still process messages for these chains.
        let relayer_router = self.build_router(prep_queues, sender.clone()).await;
        let server = self
            .core
            .settings
            .server(self.core_metrics.clone())
            .expect("Failed to create server");
        let server_task = tokio::spawn(
            async move {
                let _ = server.run_with_custom_router(relayer_router).await;
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

type PrepQueue = HashMap<
    u32,
    Arc<
        tokio::sync::Mutex<
            std::collections::BinaryHeap<std::cmp::Reverse<Box<dyn PendingOperation + 'static>>>,
        >,
    >,
>;
impl Relayer {
    async fn build_router(
        &self,
        prep_queues: Arc<RwLock<PrepQueue>>,
        sender: BroadcastSender<relayer_server::operations::message_retry::MessageRetryRequest>,
    ) -> Router {
        let origins = self.origins.read().await;
        let destinations = self.destinations.read().await;
        let msg_ctxs = self.msg_ctxs.read().await;

        let dbs: HashMap<u32, HyperlaneRocksDB> = origins
            .iter()
            .map(|(origin_domain, origin)| (origin_domain.id(), origin.database.clone()))
            .chain(
                destinations
                    .iter()
                    .map(|(dest_domain, dest)| (dest_domain.id(), dest.database.clone())),
            )
            .collect();

        let gas_enforcers: HashMap<_, _> = msg_ctxs
            .iter()
            .map(|(key, ctx)| (key.origin.clone(), ctx.origin_gas_payment_enforcer.clone()))
            .collect();

        let msg_ctxs_for_server = msg_ctxs
            .iter()
            .map(|(key, value)| ((key.origin.id(), key.destination.id()), value.clone()))
            .collect();
        let prover_syncs: HashMap<_, _> = origins
            .iter()
            .map(|(key, origin)| (key.id(), origin.prover_sync.clone()))
            .collect();
        let dispatcher_entrypoints: HashMap<_, _> = destinations
            .iter()
            .filter_map(|(domain, dest)| {
                dest.dispatcher_entrypoint.as_ref().map(|entrypoint| {
                    (
                        domain.id(),
                        Arc::new(entrypoint.clone()) as Arc<dyn CommandEntrypoint>,
                    )
                })
            })
            .collect();

        let prep_queues_snapshot = prep_queues.read().await.clone();

        relayer_server::Server::new(destinations.len())
            .with_op_retry(sender)
            .with_message_queue(prep_queues_snapshot)
            .with_dbs(dbs)
            .with_gas_enforcers(gas_enforcers)
            .with_msg_ctxs(msg_ctxs_for_server)
            .with_prover_sync(prover_syncs)
            .with_dispatcher_command_entrypoints(dispatcher_entrypoints)
            .router()
    }

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
        format!("contract::sync::{prefix}{domain}")
    }

    fn run_message_db_loader(
        &self,
        origin: &Origin,
        send_channels: &HashMap<u32, UnboundedSender<QueueOperation>>,
        destinations: &HashMap<HyperlaneDomain, Destination>,
        msg_ctxs: &HashMap<ContextKey, Arc<MessageContext>>,
        task_monitor: TaskMonitor,
    ) -> eyre::Result<JoinHandle<()>> {
        let metrics =
            MessageDbLoaderMetrics::new(&self.core.metrics, &origin.domain, destinations.keys());
        let destination_ctxs: HashMap<_, _> = destinations
            .keys()
            .filter_map(|destination| {
                let key = ContextKey {
                    origin: origin.domain.clone(),
                    destination: destination.clone(),
                };
                let context = msg_ctxs.get(&key).map(|c| (destination.id(), c.clone()));

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
            send_channels.clone(),
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
                            "destination processor panicked for destination {destination}: {err:?}"
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

    #[allow(clippy::too_many_arguments)]
    async fn build_chains_incrementally(
        settings: &RelayerSettings,
        db: DB,
        core_metrics: Arc<CoreMetrics>,
        chain_metrics: &ChainMetrics,
        dispatcher_metrics: DispatcherMetrics,
        initial_chain_readiness_timeout: Duration,
    ) -> Result<(
        HashMap<HyperlaneDomain, Origin>,
        Vec<OriginInitFuture>,
        HashMap<HyperlaneDomain, Destination>,
        Vec<DestinationInitFuture>,
    )> {
        use destination::DestinationFactory;
        use origin::OriginFactory;

        let contract_sync_metrics = Arc::new(ContractSyncMetrics::new(&core_metrics));
        let origin_factory = Arc::new(OriginFactory::new(
            db.clone(),
            core_metrics.clone(),
            contract_sync_metrics,
            ADVANCED_LOG_META,
            settings.tx_id_indexing_enabled,
            settings.igp_indexing_enabled,
        ));
        let dest_factory = Arc::new(DestinationFactory::new(db, core_metrics.clone()));

        // Track retry counts per domain
        let mut origin_retry_counts: HashMap<HyperlaneDomain, u32> = HashMap::new();
        let mut dest_retry_counts: HashMap<HyperlaneDomain, u32> = HashMap::new();

        let gas_payment_enforcement = settings.gas_payment_enforcement.clone();
        let mut origin_futures: Vec<OriginInitFuture> = settings
            .chains
            .iter()
            .map(|(domain, chain)| {
                Self::create_origin_init_future(
                    domain.clone(),
                    chain.clone(),
                    origin_factory.clone(),
                    gas_payment_enforcement.clone(),
                    0,
                )
            })
            .collect();

        let mut dest_futures: Vec<DestinationInitFuture> = settings
            .chains
            .iter()
            .map(|(domain, chain)| {
                Self::create_destination_init_future(
                    domain.clone(),
                    chain.clone(),
                    dest_factory.clone(),
                    dispatcher_metrics.clone(),
                    0,
                )
            })
            .collect();

        let mut ready_origins: HashMap<HyperlaneDomain, Origin> = HashMap::new();
        let mut ready_destinations: HashMap<HyperlaneDomain, Destination> = HashMap::new();

        let start = Instant::now();
        // Use checked_add to avoid arithmetic side effects lint
        let timeout_at = start
            .checked_add(initial_chain_readiness_timeout)
            .unwrap_or(start);

        while (!origin_futures.is_empty() || !dest_futures.is_empty())
            && (ready_origins.is_empty() || ready_destinations.is_empty())
        {
            let remaining_timeout = timeout_at.saturating_duration_since(Instant::now());
            if remaining_timeout.is_zero() {
                break;
            }

            tokio::select! {
                biased;

                result = Self::poll_next_origin(&mut origin_futures), if !origin_futures.is_empty() => {
                    if let Some((domain, outcome)) = result {
                        match outcome {
                            Ok(origin) => {
                                info!(domain = %domain.name(), "Origin chain ready");
                                ready_origins.insert(domain, origin);
                            }
                            Err(err) => {
                                let retry_count = origin_retry_counts.entry(domain.clone()).or_insert(0);
                                *retry_count = retry_count.saturating_add(1);

                                if *retry_count < CHAIN_INIT_MAX_RETRIES {
                                    let delay = Self::calculate_retry_delay(*retry_count);
                                    warn!(
                                        domain = %domain.name(),
                                        retry_count = *retry_count,
                                        max_retries = CHAIN_INIT_MAX_RETRIES,
                                        delay_secs = delay.as_secs(),
                                        error = %err,
                                        "Origin chain initialization failed, scheduling retry"
                                    );

                                    if let Some(chain_conf) = settings.chains.get(&domain) {
                                        let retry_future = Self::create_origin_init_future(
                                            domain,
                                            chain_conf.clone(),
                                            origin_factory.clone(),
                                            gas_payment_enforcement.clone(),
                                            delay.as_secs(),
                                        );
                                        origin_futures.push(retry_future);
                                    }
                                } else {
                                    Self::record_critical_error(
                                        &domain,
                                        chain_metrics,
                                        &err,
                                        "Critical error when building chain as origin (max retries exceeded)",
                                    );
                                }
                            }
                        }
                    }
                }

                result = Self::poll_next_destination(&mut dest_futures), if !dest_futures.is_empty() => {
                    if let Some((domain, outcome)) = result {
                        match outcome {
                            Ok(destination) => {
                                info!(domain = %domain.name(), "Destination chain ready");
                                ready_destinations.insert(domain, destination);
                            }
                            Err(err) => {
                                let retry_count = dest_retry_counts.entry(domain.clone()).or_insert(0);
                                *retry_count = retry_count.saturating_add(1);

                                if *retry_count < CHAIN_INIT_MAX_RETRIES {
                                    let delay = Self::calculate_retry_delay(*retry_count);
                                    warn!(
                                        domain = %domain.name(),
                                        retry_count = *retry_count,
                                        max_retries = CHAIN_INIT_MAX_RETRIES,
                                        delay_secs = delay.as_secs(),
                                        error = %err,
                                        "Destination chain initialization failed, scheduling retry"
                                    );

                                    if let Some(chain_conf) = settings.chains.get(&domain) {
                                        let retry_future = Self::create_destination_init_future(
                                            domain,
                                            chain_conf.clone(),
                                            dest_factory.clone(),
                                            dispatcher_metrics.clone(),
                                            delay.as_secs(),
                                        );
                                        dest_futures.push(retry_future);
                                    }
                                } else {
                                    Self::record_critical_error(
                                        &domain,
                                        chain_metrics,
                                        &err,
                                        "Critical error when building chain as destination (max retries exceeded)",
                                    );
                                }
                            }
                        }
                    }
                }

                _ = tokio::time::sleep(remaining_timeout) => {
                    warn!(
                        elapsed = ?start.elapsed(),
                        ready_origins = ready_origins.len(),
                        ready_destinations = ready_destinations.len(),
                        pending_origins = origin_futures.len(),
                        pending_destinations = dest_futures.len(),
                        "Chain initialization timeout reached"
                    );
                    break;
                }
            }
        }

        if ready_origins.is_empty() || ready_destinations.is_empty() {
            return Err(eyre::eyre!(
                "Failed to initialize minimum required chains. Origins: {}, Destinations: {}",
                ready_origins.len(),
                ready_destinations.len()
            ));
        }

        info!(
            elapsed = ?start.elapsed(),
            ready_origins = ready_origins.len(),
            pending_origins = origin_futures.len(),
            ready_destinations = ready_destinations.len(),
            pending_destinations = dest_futures.len(),
            "Initial chain readiness achieved"
        );

        settings
            .origin_chains
            .iter()
            .filter(|domain| !settings.chains.contains_key(domain))
            .for_each(|domain| {
                Self::record_critical_error(
                    domain,
                    chain_metrics,
                    &FactoryError::MissingConfiguration(domain.name().to_string()),
                    "Critical error when building chain as origin",
                );
            });

        settings
            .destination_chains
            .iter()
            .filter(|domain| !settings.chains.contains_key(domain))
            .for_each(|domain| {
                Self::record_critical_error(
                    domain,
                    chain_metrics,
                    &FactoryError::MissingConfiguration(domain.name().to_string()),
                    "Critical error when building chain as destination",
                );
            });

        Ok((
            ready_origins,
            origin_futures,
            ready_destinations,
            dest_futures,
        ))
    }

    async fn poll_next_origin(
        futures: &mut Vec<OriginInitFuture>,
    ) -> Option<(HyperlaneDomain, Result<Origin, origin::FactoryError>)> {
        if futures.is_empty() {
            return None;
        }
        let (result, _index, remaining) = select_all(futures.drain(..)).await;
        *futures = remaining;
        Some(result)
    }

    async fn poll_next_destination(
        futures: &mut Vec<DestinationInitFuture>,
    ) -> Option<(
        HyperlaneDomain,
        Result<Destination, destination::FactoryError>,
    )> {
        if futures.is_empty() {
            return None;
        }
        let (result, _index, remaining) = select_all(futures.drain(..)).await;
        *futures = remaining;
        Some(result)
    }

    /// Calculate exponential backoff delay for retry attempts.
    fn calculate_retry_delay(retry_count: u32) -> Duration {
        // Exponential backoff with a cap: 5s, 10s, 20s, 40s, ...
        let multiplier = 2u64.saturating_pow(retry_count.saturating_sub(1));
        let delay_secs = CHAIN_INIT_RETRY_BASE_DELAY
            .as_secs()
            .saturating_mul(multiplier);
        // Cap at 60 seconds
        Duration::from_secs(delay_secs.min(60))
    }

    /// Create an origin initialization future with optional delay for retries.
    fn create_origin_init_future(
        domain: HyperlaneDomain,
        chain_conf: hyperlane_base::settings::ChainConf,
        factory: Arc<origin::OriginFactory>,
        gas_payment_enforcement: Vec<crate::settings::GasPaymentEnforcementConf>,
        delay_secs: u64,
    ) -> OriginInitFuture {
        use origin::Factory as OriginFactoryTrait;

        Box::pin(async move {
            if delay_secs > 0 {
                tokio::time::sleep(Duration::from_secs(delay_secs)).await;
            }
            let result = factory
                .create(domain.clone(), &chain_conf, gas_payment_enforcement)
                .await;
            (domain, result)
        })
    }

    /// Create a destination initialization future with optional delay for retries.
    fn create_destination_init_future(
        domain: HyperlaneDomain,
        chain_conf: hyperlane_base::settings::ChainConf,
        factory: Arc<destination::DestinationFactory>,
        dispatcher_metrics: DispatcherMetrics,
        delay_secs: u64,
    ) -> DestinationInitFuture {
        use destination::Factory as DestinationFactoryTrait;

        Box::pin(async move {
            if delay_secs > 0 {
                tokio::time::sleep(Duration::from_secs(delay_secs)).await;
            }
            let result = factory
                .create(domain.clone(), chain_conf, dispatcher_metrics)
                .await;
            (domain, result)
        })
    }

    /// Build message contexts for all origin-destination pairs.
    ///
    /// This function accepts iterators to work with both owned and borrowed collections.
    #[allow(clippy::too_many_arguments)]
    fn build_message_contexts<'a, O, D>(
        origins: O,
        destinations: D,
        skip_transaction_gas_limit_for: &HashSet<u32>,
        transaction_gas_limit: Option<U256>,
        allow_local_checkpoint_syncers: bool,
        metrics: &Arc<CoreMetrics>,
        cache: &OptionalCache<MeteredCache<LocalCache>>,
        metric_app_contexts: &[(MatchingList, String)],
        ism_cache_configs: &[IsmCacheConfig],
        core_metrics: &Arc<CoreMetrics>,
    ) -> HashMap<ContextKey, Arc<MessageContext>>
    where
        O: IntoIterator<Item = (&'a HyperlaneDomain, &'a Origin)> + Clone,
        D: IntoIterator<Item = (&'a HyperlaneDomain, &'a Destination)> + Clone,
    {
        let mut msg_ctxs = HashMap::new();

        for (destination_domain, destination) in destinations.clone() {
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

            for (origin_domain, origin) in origins.clone() {
                let db = &origin.database;

                let origin_chain_setup = origin.chain_conf.clone();
                let prover_sync = origin.prover_sync.clone();
                let origin_gas_payment_enforcer = origin.gas_payment_enforcer.clone();
                let validator_announce = origin.validator_announce.clone();

                let metadata_builder = BaseMetadataBuilder::new(
                    origin_domain.clone(),
                    destination_chain_setup.clone(),
                    prover_sync,
                    validator_announce.clone(),
                    allow_local_checkpoint_syncers,
                    metrics.clone(),
                    cache.clone(),
                    db.clone(),
                    IsmAwareAppContextClassifier::new(
                        default_ism_getter.clone(),
                        metric_app_contexts.to_vec(),
                    ),
                    IsmCachePolicyClassifier::new(
                        default_ism_getter.clone(),
                        ism_cache_configs.to_vec(),
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
                            core_metrics,
                            origin_domain,
                            destination_domain,
                        ),
                        application_operation_verifier: application_operation_verifier.clone(),
                    }),
                );
            }
        }

        msg_ctxs
    }

    #[allow(clippy::too_many_arguments)]
    async fn spawn_destination_tasks(
        &self,
        dest_domain: &HyperlaneDomain,
        destination: &Destination,
        origins: &HashMap<HyperlaneDomain, Origin>,
        sender: &BroadcastSender<relayer_server::operations::message_retry::MessageRetryRequest>,
        send_channels: Arc<RwLock<HashMap<u32, UnboundedSender<QueueOperation>>>>,
        prep_queues: Arc<RwLock<PrepQueue>>,
        task_monitor: TaskMonitor,
    ) -> Vec<JoinHandle<()>> {
        let mut tasks = vec![];
        let dest_conf = &destination.chain_conf;

        // Match original behavior: skip destination when origin DB is missing
        let db = match origins.get(dest_domain) {
            Some(origin) => origin.database.clone(),
            None => {
                error!(domain=?dest_domain.name(), "DB missing for destination, skipping destination tasks");
                return tasks;
            }
        };

        let (send_channel, receive_channel) = mpsc::unbounded_channel::<QueueOperation>();
        send_channels
            .write()
            .await
            .insert(dest_domain.id(), send_channel);

        let dispatcher_entrypoint = destination.dispatcher_entrypoint.clone();

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
        let max_submit_queue_len = self
            .core
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
            sender,
            MessageProcessorMetrics::new(&self.core.metrics, dest_domain),
            max_batch_size,
            max_submit_queue_len,
            task_monitor.clone(),
            dispatcher_entrypoint,
            db,
        );
        prep_queues
            .write()
            .await
            .insert(dest_domain.id(), message_processor.prepare_queue().await);

        tasks.push(self.run_destination_processor(
            dest_domain,
            message_processor,
            task_monitor.clone(),
        ));

        if let Some(dispatcher) = destination.dispatcher.clone() {
            tasks.push(dispatcher.spawn().await);
        }

        match ChainSpecificMetricsUpdater::new(
            dest_conf,
            self.core_metrics.clone(),
            self.agent_metrics.clone(),
            self.chain_metrics.clone(),
            Self::AGENT_NAME.to_string(),
        )
        .await
        {
            Ok(task) => tasks.push(task.spawn()),
            Err(err) => {
                Self::record_critical_error(
                    dest_domain,
                    &self.chain_metrics,
                    &err,
                    "Failed to build metrics updater",
                );
            }
        };

        tasks
    }

    async fn spawn_origin_tasks(
        &self,
        origin_domain: &HyperlaneDomain,
        origin: &Origin,
        send_channels: &HashMap<u32, UnboundedSender<QueueOperation>>,
        task_monitor: TaskMonitor,
    ) -> Vec<JoinHandle<()>> {
        let mut tasks = vec![];

        let maybe_broadcaster = origin.message_sync.get_broadcaster();

        match self.run_message_sync(origin, task_monitor.clone()).await {
            Ok(task) => tasks.push(task),
            Err(err) => {
                Self::record_critical_error(
                    origin_domain,
                    &self.chain_metrics,
                    &err,
                    "Failed to run message sync",
                );
            }
        }

        match self
            .run_interchain_gas_payment_sync(
                origin,
                BroadcastMpscSender::map_get_receiver(maybe_broadcaster.as_ref()).await,
                task_monitor.clone(),
            )
            .await
        {
            Ok(Some(task)) => tasks.push(task),
            Ok(None) => {}
            Err(err) => {
                Self::record_critical_error(
                    &origin.domain,
                    &self.chain_metrics,
                    &err,
                    "Failed to run interchain gas payment sync",
                );
            }
        }

        match self
            .run_merkle_tree_hook_sync(
                origin,
                BroadcastMpscSender::map_get_receiver(maybe_broadcaster.as_ref()).await,
                task_monitor.clone(),
            )
            .await
        {
            Ok(task) => tasks.push(task),
            Err(err) => {
                Self::record_critical_error(
                    origin_domain,
                    &self.chain_metrics,
                    &err,
                    "Failed to run merkle tree hook sync",
                );
            }
        }

        let destinations = self.destinations.read().await;
        let msg_ctxs = self.msg_ctxs.read().await;
        match self.run_message_db_loader(
            origin,
            send_channels,
            &destinations,
            &msg_ctxs,
            task_monitor.clone(),
        ) {
            Ok(task) => tasks.push(task),
            Err(err) => {
                Self::record_critical_error(
                    origin_domain,
                    &self.chain_metrics,
                    &err,
                    "Failed to run message db loader",
                );
            }
        }

        match self.run_merkle_tree_db_loader(origin, task_monitor.clone()) {
            Ok(task) => tasks.push(task),
            Err(err) => {
                Self::record_critical_error(
                    origin_domain,
                    &self.chain_metrics,
                    &err,
                    "Failed to run merkle tree db loader",
                );
            }
        }

        tasks
    }

    #[allow(clippy::too_many_arguments)]
    fn spawn_background_chain_init(
        &self,
        pending_init: PendingChainInit,
        sender: BroadcastSender<relayer_server::operations::message_retry::MessageRetryRequest>,
        send_channels: Arc<RwLock<HashMap<u32, UnboundedSender<QueueOperation>>>>,
        prep_queues: Arc<RwLock<PrepQueue>>,
        task_monitor: TaskMonitor,
    ) -> JoinHandle<()> {
        let origins = self.origins.clone();
        let destinations = self.destinations.clone();
        let msg_ctxs = self.msg_ctxs.clone();
        let chain_metrics = self.chain_metrics.clone();
        let core_metrics = self.core_metrics.clone();
        let agent_metrics = self.agent_metrics.clone();
        let chain_settings = self.core.settings.chains.clone();

        let skip_transaction_gas_limit_for = self.skip_transaction_gas_limit_for.clone();
        let transaction_gas_limit = self.transaction_gas_limit;
        let allow_local_checkpoint_syncers = self.allow_local_checkpoint_syncers;
        let metric_app_contexts = self.metric_app_contexts.clone();
        let ism_cache_configs = self.ism_cache_configs.clone();
        let message_whitelist = self.message_whitelist.clone();
        let message_blacklist = self.message_blacklist.clone();
        let address_blacklist = self.address_blacklist.clone();
        let max_retries = self.max_retries;
        let _cache = self._cache.clone();

        tokio::spawn(
            async move {
                let PendingChainInit {
                    mut origin_futures,
                    mut destination_futures,
                } = pending_init;

                while !origin_futures.is_empty() || !destination_futures.is_empty() {
                    tokio::select! {
                        biased;

                        result = Self::poll_next_origin(&mut origin_futures), if !origin_futures.is_empty() => {
                            if let Some((domain, outcome)) = result {
                                match outcome {
                                    Ok(origin) => {
                                        info!(domain = %domain.name(), "Background: Origin chain ready");

                                        origins.write().await.insert(domain.clone(), origin);

                                        let origins_read = origins.read().await;
                                        let destinations_read = destinations.read().await;

                                        if let Some(origin_ref) = origins_read.get(&domain) {
                                            let new_contexts = Self::build_message_contexts(
                                                std::iter::once((&domain, origin_ref)),
                                                destinations_read.iter(),
                                                &skip_transaction_gas_limit_for,
                                                transaction_gas_limit,
                                                allow_local_checkpoint_syncers,
                                                &core_metrics,
                                                &_cache,
                                                &metric_app_contexts,
                                                &ism_cache_configs,
                                                &core_metrics,
                                            );

                                            msg_ctxs.write().await.extend(new_contexts);

                                            let send_channels_read = send_channels.read().await;
                                            let origin_tasks = Self::spawn_origin_tasks_static(
                                                &domain,
                                                origin_ref,
                                                &send_channels_read,
                                                task_monitor.clone(),
                                                &chain_metrics,
                                                &core_metrics,
                                                &destinations,
                                                &msg_ctxs,
                                                &message_whitelist,
                                                &message_blacklist,
                                                &address_blacklist,
                                                &metric_app_contexts,
                                                max_retries,
                                            ).await;
                                            drop(send_channels_read);

                                            for task in origin_tasks {
                                                tokio::spawn(async move {
                                                    let _ = task.await;
                                                });
                                            }
                                        }
                                    }
                                    Err(err) => {
                                        Self::record_critical_error(
                                            &domain,
                                            &chain_metrics,
                                            &err,
                                            "Background: Critical error when building chain as origin",
                                        );
                                    }
                                }
                            }
                        }

                        result = Self::poll_next_destination(&mut destination_futures), if !destination_futures.is_empty() => {
                            if let Some((domain, outcome)) = result {
                                match outcome {
                                    Ok(destination) => {
                                        info!(domain = %domain.name(), "Background: Destination chain ready");

                                        let origins_read = origins.read().await;
                                        let dest_tasks = Self::spawn_destination_tasks_static(
                                            &domain,
                                            &destination,
                                            &origins_read,
                                            &sender,
                                            send_channels.clone(),
                                            prep_queues.clone(),
                                            task_monitor.clone(),
                                            &chain_metrics,
                                            &chain_settings,
                                            &core_metrics,
                                            &agent_metrics,
                                        ).await;
                                        drop(origins_read);

                                        destinations.write().await.insert(domain.clone(), destination);

                                        let origins_read = origins.read().await;
                                        let destinations_read = destinations.read().await;

                                        if let Some(dest_ref) = destinations_read.get(&domain) {
                                            let new_contexts = Self::build_message_contexts(
                                                origins_read.iter(),
                                                std::iter::once((&domain, dest_ref)),
                                                &skip_transaction_gas_limit_for,
                                                transaction_gas_limit,
                                                allow_local_checkpoint_syncers,
                                                &core_metrics,
                                                &_cache,
                                                &metric_app_contexts,
                                                &ism_cache_configs,
                                                &core_metrics,
                                            );

                                            msg_ctxs.write().await.extend(new_contexts);
                                        }

                                        for task in dest_tasks {
                                            tokio::spawn(async move {
                                                let _ = task.await;
                                            });
                                        }
                                    }
                                    Err(err) => {
                                        Self::record_critical_error(
                                            &domain,
                                            &chain_metrics,
                                            &err,
                                            "Background: Critical error when building chain as destination",
                                        );
                                    }
                                }
                            }
                        }
                    }
                }

                info!("Background chain initialization complete");
            }
            .instrument(info_span!("BackgroundChainInit")),
        )
    }

    #[allow(clippy::too_many_arguments)]
    async fn spawn_origin_tasks_static(
        origin_domain: &HyperlaneDomain,
        origin: &Origin,
        send_channels: &HashMap<u32, UnboundedSender<QueueOperation>>,
        task_monitor: TaskMonitor,
        chain_metrics: &ChainMetrics,
        core_metrics: &Arc<CoreMetrics>,
        destinations: &DynamicDestinations,
        msg_ctxs: &DynamicMessageContexts,
        message_whitelist: &Arc<MatchingList>,
        message_blacklist: &Arc<MatchingList>,
        address_blacklist: &Arc<AddressBlacklist>,
        metric_app_contexts: &[(MatchingList, String)],
        max_retries: u32,
    ) -> Vec<JoinHandle<()>> {
        let mut tasks = vec![];

        let maybe_broadcaster = origin.message_sync.get_broadcaster();

        let index_settings = origin.chain_conf.index_settings().clone();
        let contract_sync = origin.message_sync.clone();
        let origin_domain_clone = origin_domain.clone();
        let chain_metrics_clone = chain_metrics.clone();

        let name = Self::contract_sync_task_name("message::", origin_domain.name());
        let message_sync_task = tokio::task::Builder::new()
            .name(&name)
            .spawn(TaskMonitor::instrument(
                &task_monitor,
                async move {
                    Self::message_sync_task(
                        &origin_domain_clone,
                        contract_sync,
                        index_settings,
                        chain_metrics_clone,
                    )
                    .await;
                }
                .instrument(info_span!("MessageSync")),
            ))
            .expect("spawning tokio task from Builder is infallible");
        tasks.push(message_sync_task);

        if let Some(igp_sync) = origin.interchain_gas_payment_sync.as_ref() {
            let contract_sync = igp_sync.clone();
            let index_settings = origin.chain_conf.index_settings().clone();
            let origin_domain_clone = origin_domain.clone();
            let chain_metrics_clone = chain_metrics.clone();
            let tx_id_receiver =
                BroadcastMpscSender::map_get_receiver(maybe_broadcaster.as_ref()).await;

            let name = Self::contract_sync_task_name("gas_payment::", origin_domain.name());
            let igp_task = tokio::task::Builder::new()
                .name(&name)
                .spawn(TaskMonitor::instrument(
                    &task_monitor,
                    async move {
                        Self::interchain_gas_payments_sync_task(
                            &origin_domain_clone,
                            index_settings,
                            contract_sync,
                            chain_metrics_clone,
                            tx_id_receiver,
                        )
                        .await;
                    }
                    .instrument(info_span!("IgpSync")),
                ))
                .expect("spawning tokio task from Builder is infallible");
            tasks.push(igp_task);
        }

        let contract_sync = origin.merkle_tree_hook_sync.clone();
        let index_settings = origin.chain_conf.index_settings().clone();
        let origin_domain_clone = origin_domain.clone();
        let chain_metrics_clone = chain_metrics.clone();
        let tx_id_receiver =
            BroadcastMpscSender::map_get_receiver(maybe_broadcaster.as_ref()).await;

        let name = Self::contract_sync_task_name("merkle_tree::", origin_domain.name());
        let merkle_task = tokio::task::Builder::new()
            .name(&name)
            .spawn(TaskMonitor::instrument(
                &task_monitor,
                async move {
                    Self::merkle_tree_hook_sync_task(
                        &origin_domain_clone,
                        index_settings,
                        contract_sync,
                        chain_metrics_clone,
                        tx_id_receiver,
                    )
                    .await;
                }
                .instrument(info_span!("MerkleTreeHookSync")),
            ))
            .expect("spawning tokio task from Builder is infallible");
        tasks.push(merkle_task);

        let destinations_read = destinations.read().await;
        let msg_ctxs_read = msg_ctxs.read().await;

        let metrics =
            MessageDbLoaderMetrics::new(core_metrics, &origin.domain, destinations_read.keys());
        let destination_ctxs: HashMap<_, _> = destinations_read
            .keys()
            .filter_map(|destination| {
                let key = ContextKey {
                    origin: origin.domain.clone(),
                    destination: destination.clone(),
                };
                msg_ctxs_read
                    .get(&key)
                    .map(|c| (destination.id(), c.clone()))
            })
            .collect();

        let message_db_loader = MessageDbLoader::new(
            origin.database.clone(),
            message_whitelist.clone(),
            message_blacklist.clone(),
            address_blacklist.clone(),
            metrics,
            send_channels.clone(),
            destination_ctxs,
            metric_app_contexts.to_vec(),
            max_retries,
        );

        let span = info_span!("MessageDbLoader", origin=%message_db_loader.domain());
        let db_loader = DbLoader::new(Box::new(message_db_loader), task_monitor.clone());
        tasks.push(db_loader.spawn(span));

        let metrics = MerkleTreeDbLoaderMetrics::new(core_metrics, &origin.domain);
        let merkle_tree_db_loader =
            MerkleTreeDbLoader::new(origin.database.clone(), metrics, origin.prover_sync.clone());
        let span = info_span!("MerkleTreeDbLoader", origin=%merkle_tree_db_loader.domain());
        let db_loader = DbLoader::new(Box::new(merkle_tree_db_loader), task_monitor.clone());
        tasks.push(db_loader.spawn(span));

        tasks
    }

    #[allow(clippy::panic)]
    #[allow(clippy::too_many_arguments)]
    async fn spawn_destination_tasks_static(
        dest_domain: &HyperlaneDomain,
        destination: &Destination,
        origins: &HashMap<HyperlaneDomain, Origin>,
        sender: &BroadcastSender<relayer_server::operations::message_retry::MessageRetryRequest>,
        send_channels: Arc<RwLock<HashMap<u32, UnboundedSender<QueueOperation>>>>,
        prep_queues: Arc<RwLock<PrepQueue>>,
        task_monitor: TaskMonitor,
        chain_metrics: &ChainMetrics,
        chain_settings: &HashMap<HyperlaneDomain, hyperlane_base::settings::ChainConf>,
        core_metrics: &Arc<CoreMetrics>,
        agent_metrics: &AgentMetrics,
    ) -> Vec<JoinHandle<()>> {
        let mut tasks = vec![];
        let dest_conf = &destination.chain_conf;

        // Match original behavior: skip destination when origin DB is missing
        let db = match origins.get(dest_domain) {
            Some(origin) => origin.database.clone(),
            None => {
                error!(domain=?dest_domain.name(), "DB missing for destination, skipping destination tasks");
                return tasks;
            }
        };

        let (send_channel, receive_channel) = mpsc::unbounded_channel::<QueueOperation>();
        send_channels
            .write()
            .await
            .insert(dest_domain.id(), send_channel);

        let dispatcher_entrypoint = destination.dispatcher_entrypoint.clone();

        let max_batch_size = chain_settings
            .get(dest_domain)
            .and_then(|chain| {
                chain
                    .connection
                    .operation_submission_config()
                    .map(|c| c.max_batch_size)
            })
            .unwrap_or(1);
        let max_submit_queue_len = chain_settings.get(dest_domain).and_then(|chain| {
            chain
                .connection
                .operation_submission_config()
                .and_then(|c| c.max_submit_queue_length)
        });

        let message_processor = MessageProcessor::new(
            dest_domain.clone(),
            receive_channel,
            sender,
            MessageProcessorMetrics::new(core_metrics, dest_domain),
            max_batch_size,
            max_submit_queue_len,
            task_monitor.clone(),
            dispatcher_entrypoint,
            db,
        );
        prep_queues
            .write()
            .await
            .insert(dest_domain.id(), message_processor.prepare_queue().await);

        let span = info_span!("MessageProcessor", destination=%dest_domain);
        let dest_domain_clone = dest_domain.clone();
        let name = format!("message_processor::destination::{}", dest_domain.name());
        let processor_task = tokio::task::Builder::new()
            .name(&name)
            .spawn(TaskMonitor::instrument(
                &task_monitor,
                async move {
                    message_processor.spawn().await.unwrap_or_else(|err| {
                        panic!(
                            "destination processor panicked for destination {dest_domain_clone}: {err:?}"
                        )
                    });
                }
                .instrument(span),
            ))
            .expect("spawning tokio task from Builder is infallible");
        tasks.push(processor_task);

        if let Some(dispatcher) = destination.dispatcher.clone() {
            tasks.push(dispatcher.spawn().await);
        }

        match ChainSpecificMetricsUpdater::new(
            dest_conf,
            core_metrics.clone(),
            agent_metrics.clone(),
            chain_metrics.clone(),
            Relayer::AGENT_NAME.to_string(),
        )
        .await
        {
            Ok(task) => tasks.push(task.spawn()),
            Err(err) => {
                Self::record_critical_error(
                    dest_domain,
                    chain_metrics,
                    &err,
                    "Failed to build metrics updater",
                );
            }
        };

        tasks
    }
}

#[cfg(test)]
mod tests;
