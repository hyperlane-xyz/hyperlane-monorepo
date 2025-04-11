use std::{
    collections::{HashMap, HashSet},
    fmt::{Debug, Formatter},
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
        RwLock,
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
    settings::{ChainConf, IndexSettings},
    AgentMetadata, BaseAgent, ChainMetrics, ContractSyncMetrics, ContractSyncer, CoreMetrics,
    HyperlaneAgentCore, RuntimeMetrics, SyncOptions,
};
use hyperlane_core::{
    rpc_clients::call_and_retry_n_times, ChainCommunicationError, ChainResult, ContractSyncCursor,
    HyperlaneDomain, HyperlaneMessage, InterchainGasPayment, Mailbox, MerkleTreeInsertion,
    QueueOperation, SubmitterType, ValidatorAnnounce, H512, U256,
};
use hyperlane_operation_verifier::ApplicationOperationVerifier;
use submitter::{
    DatabaseOrPath, PayloadDispatcher, PayloadDispatcherEntrypoint, PayloadDispatcherSettings,
};

use crate::{
    merkle_tree::builder::MerkleTreeBuilder,
    msg::{
        blacklist::AddressBlacklist,
        gas_payment::GasPaymentEnforcer,
        metadata::{
            BaseMetadataBuilder, DefaultIsmCache, IsmAwareAppContextClassifier,
            IsmCachePolicyClassifier,
        },
        op_submitter::{SerialSubmitter, SerialSubmitterMetrics},
        pending_message::{MessageContext, MessageSubmissionMetrics},
        processor::{MessageProcessor, MessageProcessorMetrics},
    },
    server::{self as relayer_server},
    settings::{matching_list::MatchingList, RelayerSettings},
};
use crate::{
    merkle_tree::processor::{MerkleTreeProcessor, MerkleTreeProcessorMetrics},
    processor::ProcessorExt,
};
use crate::{processor::Processor, server::ENDPOINT_MESSAGES_QUEUE_SIZE};

const CURSOR_BUILDING_ERROR: &str = "Error building cursor for origin";
const CURSOR_INSTANTIATION_ATTEMPTS: usize = 10;

#[derive(Debug, Hash, PartialEq, Eq, Copy, Clone)]
struct ContextKey {
    origin: u32,
    destination: u32,
}

/// A relayer agent
#[derive(AsRef)]
pub struct Relayer {
    origin_chains: HashSet<HyperlaneDomain>,
    destination_chains: HashMap<HyperlaneDomain, ChainConf>,
    #[as_ref]
    core: HyperlaneAgentCore,
    message_syncs: HashMap<HyperlaneDomain, Arc<dyn ContractSyncer<HyperlaneMessage>>>,
    interchain_gas_payment_syncs:
        HashMap<HyperlaneDomain, Arc<dyn ContractSyncer<InterchainGasPayment>>>,
    /// Context data for each (origin, destination) chain pair a message can be
    /// sent between
    msg_ctxs: HashMap<ContextKey, Arc<MessageContext>>,
    prover_syncs: HashMap<HyperlaneDomain, Arc<RwLock<MerkleTreeBuilder>>>,
    merkle_tree_hook_syncs: HashMap<HyperlaneDomain, Arc<dyn ContractSyncer<MerkleTreeInsertion>>>,
    dbs: HashMap<HyperlaneDomain, HyperlaneRocksDB>,
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
    payload_dispatcher_entrypoints: HashMap<HyperlaneDomain, PayloadDispatcherEntrypoint>,
    payload_dispatchers: HashMap<HyperlaneDomain, PayloadDispatcher>,
}

impl Debug for Relayer {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Relayer {{ origin_chains: {:?}, destination_chains: {:?}, message_whitelist: {:?}, message_blacklist: {:?}, address_blacklist: {:?}, transaction_gas_limit: {:?}, skip_transaction_gas_limit_for: {:?}, allow_local_checkpoint_syncers: {:?} }}",
            self.origin_chains,
            self.destination_chains,
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

    async fn from_settings(
        _agent_metadata: AgentMetadata,
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
        let mut start_entity_init = Instant::now();

        let core = settings.build_hyperlane_core(core_metrics.clone());
        let db = DB::from_path(&settings.db)?;
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
        let dbs = settings
            .origin_chains
            .iter()
            .map(|origin| (origin.clone(), HyperlaneRocksDB::new(origin, db.clone())))
            .collect::<HashMap<_, _>>();
        debug!(elapsed = ?start_entity_init.elapsed(), event = "initialized databases", "Relayer startup duration measurement");

        start_entity_init = Instant::now();
        let application_operation_verifiers =
            Self::build_application_operation_verifiers(&settings, &core_metrics, &chain_metrics)
                .await;
        debug!(elapsed = ?start_entity_init.elapsed(), event = "initialized application operation verifiers", "Relayer startup duration measurement");

        start_entity_init = Instant::now();
        let mailboxes = Self::build_mailboxes(&settings, &core_metrics, &chain_metrics).await;
        debug!(elapsed = ?start_entity_init.elapsed(), event = "initialized mailbox", "Relayer startup duration measurement");

        start_entity_init = Instant::now();
        let validator_announces =
            Self::build_validator_announces(&settings, &core_metrics, &chain_metrics).await;
        debug!(elapsed = ?start_entity_init.elapsed(), event = "initialized validator announces", "Relayer startup duration measurement");

        start_entity_init = Instant::now();
        let dispatcher_entrypoints = Self::build_payload_dispatcher_entrypoints(
            &settings,
            core_metrics.clone(),
            &chain_metrics,
            db.clone(),
        )
        .await;
        debug!(elapsed = ?start_entity_init.elapsed(), event = "initialized dispatcher entrypoints", "Relayer startup duration measurement");

        start_entity_init = Instant::now();
        let dispatchers = Self::build_payload_dispatchers(
            &settings,
            core_metrics.clone(),
            &chain_metrics,
            db.clone(),
        )
        .await;
        debug!(elapsed = ?start_entity_init.elapsed(), event = "initialized dipatchers", "Relayer startup duration measurement");

        let contract_sync_metrics = Arc::new(ContractSyncMetrics::new(&core_metrics));

        start_entity_init = Instant::now();
        let message_syncs: HashMap<_, Arc<dyn ContractSyncer<HyperlaneMessage>>> = settings
            .contract_syncs::<HyperlaneMessage, _>(
                settings.origin_chains.iter(),
                &core_metrics,
                &contract_sync_metrics,
                dbs.iter()
                    .map(|(d, db)| (d.clone(), Arc::new(db.clone())))
                    .collect(),
                false,
            )
            .await?
            .into_iter()
            .map(|(k, v)| (k, v as _))
            .collect();
        debug!(elapsed = ?start_entity_init.elapsed(), event = "initialized message syncs", "Relayer startup duration measurement");

        start_entity_init = Instant::now();
        let interchain_gas_payment_syncs = settings
            .contract_syncs::<InterchainGasPayment, _>(
                settings.origin_chains.iter(),
                &core_metrics,
                &contract_sync_metrics,
                dbs.iter()
                    .map(|(d, db)| (d.clone(), Arc::new(db.clone())))
                    .collect(),
                false,
            )
            .await?
            .into_iter()
            .map(|(k, v)| (k, v as _))
            .collect();
        debug!(elapsed = ?start_entity_init.elapsed(), event = "initialized IGP syncs", "Relayer startup duration measurement");

        start_entity_init = Instant::now();
        let merkle_tree_hook_syncs = settings
            .contract_syncs::<MerkleTreeInsertion, _>(
                settings.origin_chains.iter(),
                &core_metrics,
                &contract_sync_metrics,
                dbs.iter()
                    .map(|(d, db)| (d.clone(), Arc::new(db.clone())))
                    .collect(),
                false,
            )
            .await?
            .into_iter()
            .map(|(k, v)| (k, v as _))
            .collect();
        debug!(elapsed = ?start_entity_init.elapsed(), event = "initialized merkle tree hook syncs", "Relayer startup duration measurement");

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

        // provers by origin chain
        start_entity_init = Instant::now();
        let prover_syncs = settings
            .origin_chains
            .iter()
            .map(|origin| {
                (
                    origin.clone(),
                    Arc::new(RwLock::new(MerkleTreeBuilder::new())),
                )
            })
            .collect::<HashMap<_, _>>();
        debug!(elapsed = ?start_entity_init.elapsed(), event = "initialized prover syncs", "Relayer startup duration measurement");

        info!(gas_enforcement_policies=?settings.gas_payment_enforcement, "Gas enforcement configuration");

        // need one of these per origin chain due to the database scoping even though
        // the config itself is the same
        start_entity_init = Instant::now();
        let gas_payment_enforcers: HashMap<_, _> = settings
            .origin_chains
            .iter()
            .map(|domain| {
                (
                    domain.clone(),
                    Arc::new(GasPaymentEnforcer::new(
                        settings.gas_payment_enforcement.clone(),
                        dbs.get(domain).unwrap().clone(),
                    )),
                )
            })
            .collect();
        debug!(elapsed = ?start_entity_init.elapsed(), event = "initialized gas payment enforcers", "Relayer startup duration measurement");

        let mut msg_ctxs = HashMap::new();
        let mut destination_chains = HashMap::new();

        // only iterate through destination chains that were successfully instantiated
        start_entity_init = Instant::now();
        for (destination, dest_mailbox) in mailboxes.iter() {
            let destination_chain_setup = core.settings.chain_setup(destination).unwrap().clone();
            destination_chains.insert(destination.clone(), destination_chain_setup.clone());
            let transaction_gas_limit: Option<U256> =
                if skip_transaction_gas_limit_for.contains(&destination.id()) {
                    None
                } else {
                    transaction_gas_limit
                };

            let application_operation_verifier = application_operation_verifiers.get(destination);

            // only iterate through origin chains that were successfully instantiated
            for (origin, validator_announce) in validator_announces.iter() {
                let db = dbs.get(origin).unwrap().clone();
                let default_ism_getter = DefaultIsmCache::new(dest_mailbox.clone());
                let metadata_builder = BaseMetadataBuilder::new(
                    origin.clone(),
                    destination_chain_setup.clone(),
                    prover_syncs[origin].clone(),
                    validator_announce.clone(),
                    settings.allow_local_checkpoint_syncers,
                    core.metrics.clone(),
                    cache.clone(),
                    db,
                    IsmAwareAppContextClassifier::new(
                        default_ism_getter.clone(),
                        settings.metric_app_contexts.clone(),
                    ),
                    IsmCachePolicyClassifier::new(
                        default_ism_getter.clone(),
                        settings.default_ism_cache_config.clone(),
                    ),
                );

                msg_ctxs.insert(
                    ContextKey {
                        origin: origin.id(),
                        destination: destination.id(),
                    },
                    Arc::new(MessageContext {
                        destination_mailbox: dest_mailbox.clone(),
                        origin_db: Arc::new(dbs.get(origin).unwrap().clone()),
                        cache: cache.clone(),
                        metadata_builder: Arc::new(metadata_builder),
                        origin_gas_payment_enforcer: gas_payment_enforcers[origin].clone(),
                        transaction_gas_limit,
                        metrics: MessageSubmissionMetrics::new(&core_metrics, origin, destination),
                        application_operation_verifier: application_operation_verifier.cloned(),
                    }),
                );
            }
        }
        debug!(elapsed = ?start_entity_init.elapsed(), event = "initialized message contexts", "Relayer startup duration measurement");

        debug!(elapsed = ?start.elapsed(), event = "fully initialized", "Relayer startup duration measurement");

        Ok(Self {
            dbs,
            _cache: cache,
            origin_chains: settings.origin_chains,
            destination_chains,
            msg_ctxs,
            core,
            message_syncs,
            interchain_gas_payment_syncs,
            prover_syncs,
            merkle_tree_hook_syncs,
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
            payload_dispatcher_entrypoints: dispatcher_entrypoints,
            payload_dispatchers: dispatchers,
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
        let mut send_channels = HashMap::with_capacity(self.destination_chains.len());
        let mut prep_queues = HashMap::with_capacity(self.destination_chains.len());
        start_entity_init = Instant::now();
        for (dest_domain, dest_conf) in &self.destination_chains {
            let (send_channel, receive_channel) = mpsc::unbounded_channel::<QueueOperation>();
            send_channels.insert(dest_domain.id(), send_channel);

            let payload_dispatcher_entrypoint =
                self.payload_dispatcher_entrypoints.remove(dest_domain);

            let db = self
                .dbs
                .get(dest_domain)
                .expect("DB should be created for every chain")
                .clone();

            let serial_submitter = SerialSubmitter::new(
                dest_domain.clone(),
                receive_channel,
                &sender,
                SerialSubmitterMetrics::new(&self.core.metrics, dest_domain),
                // Default to submitting one message at a time if there is no batch config
                self.core.settings.chains[dest_domain.name()]
                    .connection
                    .operation_batch_config()
                    .map(|c| c.max_batch_size)
                    .unwrap_or(1),
                task_monitor.clone(),
                payload_dispatcher_entrypoint,
                db,
            );
            prep_queues.insert(dest_domain.id(), serial_submitter.prepare_queue().await);

            tasks.push(self.run_destination_submitter(
                dest_domain,
                serial_submitter,
                task_monitor.clone(),
            ));

            if let Some(dispatcher) = self.payload_dispatchers.remove(dest_domain) {
                tasks.push(dispatcher.spawn().await);
            }

            let metrics_updater = ChainSpecificMetricsUpdater::new(
                dest_conf,
                self.core_metrics.clone(),
                self.agent_metrics.clone(),
                self.chain_metrics.clone(),
                Self::AGENT_NAME.to_string(),
            )
            .await
            .unwrap_or_else(|_| {
                panic!("Error creating metrics updater for destination {dest_domain}")
            });
            tasks.push(metrics_updater.spawn());
        }
        debug!(elapsed = ?start_entity_init.elapsed(), event = "started submitters", "Relayer startup duration measurement");

        start_entity_init = Instant::now();
        for origin in &self.origin_chains {
            let maybe_broadcaster = self
                .message_syncs
                .get(origin)
                .and_then(|sync| sync.get_broadcaster());
            tasks.push(self.run_message_sync(origin, task_monitor.clone()).await);
            tasks.push(
                self.run_interchain_gas_payment_sync(
                    origin,
                    BroadcastMpscSender::map_get_receiver(maybe_broadcaster.as_ref()).await,
                    task_monitor.clone(),
                )
                .await,
            );
            tasks.push(
                self.run_merkle_tree_hook_sync(
                    origin,
                    BroadcastMpscSender::map_get_receiver(maybe_broadcaster.as_ref()).await,
                    task_monitor.clone(),
                )
                .await,
            );
            tasks.push(self.run_message_processor(
                origin,
                send_channels.clone(),
                task_monitor.clone(),
            ));
            tasks.push(self.run_merkle_tree_processor(origin, task_monitor.clone()));
        }
        debug!(elapsed = ?start_entity_init.elapsed(), event = "started message, IGP, merkle tree hook syncs, and message and merkle tree processors", "Relayer startup duration measurement");

        // run server
        start_entity_init = Instant::now();
        let custom_routes = relayer_server::Server::new(self.destination_chains.len())
            .with_op_retry(sender.clone())
            .with_message_queue(prep_queues)
            .routes();
        let server = self
            .core
            .settings
            .server(self.core_metrics.clone())
            .expect("Failed to create server");
        let server_task = tokio::spawn(
            async move {
                server.run_with_custom_routes(custom_routes);
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
        origin: &HyperlaneDomain,
        err: ChainCommunicationError,
        message: &str,
        chain_metrics: ChainMetrics,
    ) {
        error!(?err, origin=?origin, "{message}");
        chain_metrics.set_critical_error(origin.name(), true);
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
        )
        .await
    }

    async fn run_message_sync(
        &self,
        origin: &HyperlaneDomain,
        task_monitor: TaskMonitor,
    ) -> JoinHandle<()> {
        let origin = origin.clone();
        let contract_sync = self.message_syncs.get(&origin).unwrap().clone();
        let index_settings = self.as_ref().settings.chains[origin.name()].index_settings();
        let chain_metrics = self.chain_metrics.clone();

        let name = Self::contract_sync_task_name("message::", origin.name());
        tokio::task::Builder::new()
            .name(&name)
            .spawn(TaskMonitor::instrument(
                &task_monitor,
                async move {
                    Self::message_sync_task(&origin, contract_sync, index_settings, chain_metrics)
                        .await;
                }
                .instrument(info_span!("MessageSync")),
            ))
            .expect("spawning tokio task from Builder is infallible")
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
                Self::record_critical_error(origin, err, CURSOR_BUILDING_ERROR, chain_metrics);
                return;
            }
        };
        let label = "dispatched_messages";
        contract_sync.clone().sync(label, cursor.into()).await;
        info!(chain = origin.name(), label, "contract sync task exit");
    }

    async fn run_interchain_gas_payment_sync(
        &self,
        origin: &HyperlaneDomain,
        tx_id_receiver: Option<MpscReceiver<H512>>,
        task_monitor: TaskMonitor,
    ) -> JoinHandle<()> {
        let origin = origin.clone();
        let index_settings = self.as_ref().settings.chains[origin.name()].index_settings();
        let contract_sync = self
            .interchain_gas_payment_syncs
            .get(&origin)
            .unwrap()
            .clone();
        let chain_metrics = self.chain_metrics.clone();

        let name = Self::contract_sync_task_name("gas_payment::", origin.name());
        tokio::task::Builder::new()
            .name(&name)
            .spawn(TaskMonitor::instrument(
                &task_monitor,
                async move {
                    Self::interchain_gas_payments_sync_task(
                        &origin,
                        index_settings,
                        contract_sync,
                        chain_metrics,
                        tx_id_receiver,
                    )
                    .await;
                }
                .instrument(info_span!("IgpSync")),
            ))
            .expect("spawning tokio task from Builder is infallible")
    }

    async fn interchain_gas_payments_sync_task(
        origin: &HyperlaneDomain,
        index_settings: IndexSettings,
        contract_sync: Arc<dyn ContractSyncer<InterchainGasPayment>>,
        chain_metrics: ChainMetrics,
        tx_id_receiver: Option<MpscReceiver<H512>>,
    ) {
        let cursor_instantiation_result =
            Self::instantiate_cursor_with_retries(contract_sync.clone(), index_settings.clone())
                .await;
        let cursor = match cursor_instantiation_result {
            Ok(cursor) => cursor,
            Err(err) => {
                Self::record_critical_error(origin, err, CURSOR_BUILDING_ERROR, chain_metrics);
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
        origin: &HyperlaneDomain,
        tx_id_receiver: Option<MpscReceiver<H512>>,
        task_monitor: TaskMonitor,
    ) -> JoinHandle<()> {
        let origin = origin.clone();
        let index_settings = self.as_ref().settings.chains[origin.name()].index.clone();
        let contract_sync = self.merkle_tree_hook_syncs.get(&origin).unwrap().clone();
        let chain_metrics = self.chain_metrics.clone();

        let origin_name = origin.name().to_string();
        let name = Self::contract_sync_task_name("merkle_tree::", &origin_name);
        tokio::task::Builder::new()
            .name(&name)
            .spawn(TaskMonitor::instrument(
                &task_monitor,
                async move {
                    Self::merkle_tree_hook_sync_task(
                        &origin,
                        index_settings,
                        contract_sync,
                        chain_metrics,
                        tx_id_receiver,
                    )
                    .await;
                }
                .instrument(info_span!("MerkleTreeHookSync")),
            ))
            .expect("spawning tokio task from Builder is infallible")
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
                Self::record_critical_error(origin, err, CURSOR_BUILDING_ERROR, chain_metrics);
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

    fn run_message_processor(
        &self,
        origin: &HyperlaneDomain,
        send_channels: HashMap<u32, UnboundedSender<QueueOperation>>,
        task_monitor: TaskMonitor,
    ) -> JoinHandle<()> {
        let metrics = MessageProcessorMetrics::new(
            &self.core.metrics,
            origin,
            self.destination_chains.keys(),
        );
        let destination_ctxs: HashMap<_, _> = self
            .destination_chains
            .keys()
            .filter_map(|destination| {
                let key = ContextKey {
                    origin: origin.id(),
                    destination: destination.id(),
                };
                let context = self
                    .msg_ctxs
                    .get(&key)
                    .map(|c| (destination.id(), c.clone()));

                if context.is_none() {
                    let err_msg = format!(
                        "No message context found for origin {} and destination {}",
                        origin.name(),
                        destination.name()
                    );
                    Self::record_critical_error(
                        origin,
                        ChainCommunicationError::CustomError(err_msg.clone()),
                        &err_msg,
                        self.chain_metrics.clone(),
                    );
                }

                context
            })
            .collect();

        let message_processor = MessageProcessor::new(
            self.dbs.get(origin).unwrap().clone(),
            self.message_whitelist.clone(),
            self.message_blacklist.clone(),
            self.address_blacklist.clone(),
            metrics,
            send_channels,
            destination_ctxs,
            self.metric_app_contexts.clone(),
            self.max_retries,
        );

        let span = info_span!("MessageProcessor", origin=%message_processor.domain());
        let processor = Processor::new(Box::new(message_processor), task_monitor.clone());

        processor.spawn(span)
    }

    fn run_merkle_tree_processor(
        &self,
        origin: &HyperlaneDomain,
        task_monitor: TaskMonitor,
    ) -> JoinHandle<()> {
        let metrics = MerkleTreeProcessorMetrics::new(&self.core.metrics, origin);
        let merkle_tree_processor = MerkleTreeProcessor::new(
            self.dbs.get(origin).unwrap().clone(),
            metrics,
            self.prover_syncs[origin].clone(),
        );

        let span = info_span!("MerkleTreeProcessor", origin=%merkle_tree_processor.domain());
        let processor = Processor::new(Box::new(merkle_tree_processor), task_monitor.clone());
        processor.spawn(span)
    }

    #[allow(clippy::too_many_arguments)]
    #[tracing::instrument(skip(self, serial_submitter))]
    fn run_destination_submitter(
        &self,
        destination: &HyperlaneDomain,
        serial_submitter: SerialSubmitter,
        task_monitor: TaskMonitor,
    ) -> JoinHandle<()> {
        let span = info_span!("SerialSubmitter", destination=%destination);
        let destination = destination.clone();
        let name = format!("submitter::destination::{}", destination.name());
        tokio::task::Builder::new()
            .name(&name)
            .spawn(TaskMonitor::instrument(
                &task_monitor,
                async move {
                    // Propagate task panics
                    serial_submitter.spawn().await.unwrap_or_else(|err| {
                        panic!(
                            "destination submitter panicked for destination {}: {:?}",
                            destination, err
                        )
                    });
                }
                .instrument(span),
            ))
            .expect("spawning tokio task from Builder is infallible")
    }

    /// Helper function to build and return a hashmap of mailboxes.
    /// Any chains that fail to build mailbox will not be included
    /// in the hashmap. Errors will be logged and chain metrics
    /// will be updated for chains that fail to build mailbox.
    pub async fn build_mailboxes(
        settings: &RelayerSettings,
        core_metrics: &CoreMetrics,
        chain_metrics: &ChainMetrics,
    ) -> HashMap<HyperlaneDomain, Arc<dyn Mailbox>> {
        settings
            .build_mailboxes(settings.destination_chains.iter(), core_metrics)
            .await
            .into_iter()
            .filter_map(|(origin, mailbox_res)| match mailbox_res {
                Ok(mailbox) => Some((origin, mailbox)),
                Err(err) => {
                    error!(?err, origin=?origin, "Critical error when building mailbox");
                    chain_metrics.set_critical_error(origin.name(), true);
                    None
                }
            })
            .collect()
    }

    /// Helper function to build and return a hashmap of payload dispatchers.
    /// Any chains that fail to build payload dispatcher will not be included
    /// in the hashmap. Errors will be logged and chain metrics
    /// will be updated for chains that fail to build payload dispatcher.
    pub async fn build_payload_dispatcher_entrypoints(
        settings: &RelayerSettings,
        core_metrics: Arc<CoreMetrics>,
        chain_metrics: &ChainMetrics,
        db: DB,
    ) -> HashMap<HyperlaneDomain, PayloadDispatcherEntrypoint> {
        settings.destination_chains.iter()
            .filter(|chain| SubmitterType::Lander == settings.chains[&chain.to_string()].submitter)
            .map(|chain| (chain.clone(), PayloadDispatcherSettings {
                chain_conf: settings.chains[&chain.to_string()].clone(),
                raw_chain_conf: Default::default(),
                domain: chain.clone(),
                db: DatabaseOrPath::Database(db.clone()),
                metrics: core_metrics.clone(),
            }))
            .map(|(chain, s)| (chain, PayloadDispatcherEntrypoint::try_from_settings(s)))
            .filter_map(|(chain, result)| match result {
                Ok(entrypoint) => Some((chain, entrypoint)),
                Err(err) => {
                    error!(?err, origin=?chain, "Critical error when building payload dispatcher endpoint");
                    chain_metrics.set_critical_error(chain.name(), true);
                    None
                }
            })
            .collect::<HashMap<_, _>>()
    }

    /// Helper function to build and return a hashmap of payload dispatchers.
    /// Any chains that fail to build payload dispatcher will not be included
    /// in the hashmap. Errors will be logged and chain metrics
    /// will be updated for chains that fail to build payload dispatcher.
    pub async fn build_payload_dispatchers(
        settings: &RelayerSettings,
        core_metrics: Arc<CoreMetrics>,
        chain_metrics: &ChainMetrics,
        db: DB,
    ) -> HashMap<HyperlaneDomain, PayloadDispatcher> {
        settings
            .destination_chains
            .iter()
            .filter(|chain| SubmitterType::Lander == settings.chains[&chain.to_string()].submitter)
            .map(|chain| {
                (
                    chain.clone(),
                    PayloadDispatcherSettings {
                        chain_conf: settings.chains[&chain.to_string()].clone(),
                        raw_chain_conf: Default::default(),
                        domain: chain.clone(),
                        db: DatabaseOrPath::Database(db.clone()),
                        metrics: core_metrics.clone(),
                    },
                )
            })
            .map(|(chain, s)| {
                let chain_name = chain.to_string();
                (chain, PayloadDispatcher::try_from_settings(s, chain_name))
            })
            .filter_map(|(chain, result)| match result {
                Ok(entrypoint) => Some((chain, entrypoint)),
                Err(err) => {
                    error!(?err, origin=?chain, "Critical error when building payload dispatcher");
                    chain_metrics.set_critical_error(chain.name(), true);
                    None
                }
            })
            .collect::<HashMap<_, _>>()
    }

    /// Helper function to build and return a hashmap of validator announces.
    /// Any chains that fail to build validator announce will not be included
    /// in the hashmap. Errors will be logged and chain metrics
    /// will be updated for chains that fail to build validator announce.
    pub async fn build_validator_announces(
        settings: &RelayerSettings,
        core_metrics: &CoreMetrics,
        chain_metrics: &ChainMetrics,
    ) -> HashMap<HyperlaneDomain, Arc<dyn ValidatorAnnounce>> {
        settings
            .build_validator_announces(settings.origin_chains.iter(), core_metrics)
            .await
            .into_iter()
            .filter_map(|(origin, mailbox_res)| match mailbox_res {
                Ok(mailbox) => Some((origin, mailbox)),
                Err(err) => {
                    error!(?err, origin=?origin, "Critical error when building validator announce");
                    chain_metrics.set_critical_error(origin.name(), true);
                    None
                }
            })
            .collect()
    }

    /// Helper function to build and return a hashmap of application operation verifiers.
    /// Any chains that fail to build application operation verifier will not be included
    /// in the hashmap. Errors will be logged and chain metrics
    /// will be updated for chains that fail to build application operation verifier.
    pub async fn build_application_operation_verifiers(
        settings: &RelayerSettings,
        core_metrics: &CoreMetrics,
        chain_metrics: &ChainMetrics,
    ) -> HashMap<HyperlaneDomain, Arc<dyn ApplicationOperationVerifier>> {
        settings
            .build_application_operation_verifiers(settings.origin_chains.iter(), core_metrics)
            .await
            .into_iter()
            .filter_map(|(origin, app_context_verifier_res)| match app_context_verifier_res {
                Ok(app_context_verifier) => Some((origin, app_context_verifier)),
                Err(err) => {
                    error!(?err, origin=?origin, "Critical error when building application operation verifier");
                    chain_metrics.set_critical_error(origin.name(), true);
                    None
                }
            })
            .collect()
    }

    fn reset_critical_errors(settings: &RelayerSettings, chain_metrics: &ChainMetrics) {
        settings
            .origin_chains
            .iter()
            .for_each(|origin| chain_metrics.set_critical_error(origin.name(), false));
    }
}

#[cfg(test)]
mod test {
    use std::{
        collections::{HashMap, HashSet},
        path::PathBuf,
        time::Duration,
    };

    use ethers::utils::hex;
    use ethers_prometheus::middleware::PrometheusMiddlewareConf;
    use prometheus::{opts, IntGaugeVec, Registry};
    use reqwest::Url;

    use hyperlane_base::{
        settings::{
            ChainConf, ChainConnectionConf, CoreContractAddresses, IndexSettings, Settings,
            TracingConfig,
        },
        ChainMetrics, CoreMetrics, BLOCK_HEIGHT_HELP, BLOCK_HEIGHT_LABELS, CRITICAL_ERROR_HELP,
        CRITICAL_ERROR_LABELS,
    };
    use hyperlane_core::{
        config::OperationBatchConfig, HyperlaneDomain, IndexMode, KnownHyperlaneDomain,
        ReorgPeriod, H256,
    };
    use hyperlane_ethereum as h_eth;

    use crate::settings::{matching_list::MatchingList, RelayerSettings};

    use super::Relayer;

    /// Builds a test RelayerSetting
    fn generate_test_relayer_settings() -> RelayerSettings {
        let chains = [(
            "arbitrum".to_string(),
            ChainConf {
                domain: HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
                signer: None,
                submitter: Default::default(),
                estimated_block_time: Duration::from_secs_f64(1.1),
                reorg_period: ReorgPeriod::None,
                addresses: CoreContractAddresses {
                    mailbox: H256::from_slice(
                        hex::decode(
                            "000000000000000000000000598facE78a4302f11E3de0bee1894Da0b2Cb71F8",
                        )
                        .unwrap()
                        .as_slice(),
                    ),
                    interchain_gas_paymaster: H256::from_slice(
                        hex::decode(
                            "000000000000000000000000c756cFc1b7d0d4646589EDf10eD54b201237F5e8",
                        )
                        .unwrap()
                        .as_slice(),
                    ),
                    validator_announce: H256::from_slice(
                        hex::decode(
                            "0000000000000000000000001b33611fCc073aB0737011d5512EF673Bff74962",
                        )
                        .unwrap()
                        .as_slice(),
                    ),
                    merkle_tree_hook: H256::from_slice(
                        hex::decode(
                            "000000000000000000000000AD34A66Bf6dB18E858F6B686557075568c6E031C",
                        )
                        .unwrap()
                        .as_slice(),
                    ),
                },
                connection: ChainConnectionConf::Ethereum(h_eth::ConnectionConf {
                    rpc_connection: h_eth::RpcConnectionConf::Http {
                        url: Url::parse("https://sepolia-rollup.arbitrum.io/rpc").unwrap(),
                    },
                    transaction_overrides: h_eth::TransactionOverrides {
                        gas_price: None,
                        gas_limit: None,
                        max_fee_per_gas: None,
                        max_priority_fee_per_gas: None,
                    },
                    operation_batch: OperationBatchConfig {
                        batch_contract_address: None,
                        max_batch_size: 1,
                    },
                }),
                metrics_conf: PrometheusMiddlewareConf {
                    contracts: HashMap::new(),
                    chain: None,
                },
                index: IndexSettings {
                    from: 0,
                    chunk_size: 1,
                    mode: IndexMode::Block,
                },
            },
        )];

        RelayerSettings {
            base: Settings {
                chains: chains.into_iter().collect(),
                metrics_port: 5000,
                tracing: TracingConfig::default(),
            },
            db: PathBuf::new(),
            origin_chains: [
                HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
                HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
                HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism),
            ]
            .into_iter()
            .collect(),
            destination_chains: [
                HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
                HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
                HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism),
            ]
            .into_iter()
            .collect(),
            gas_payment_enforcement: Vec::new(),
            whitelist: MatchingList::default(),
            blacklist: MatchingList::default(),
            address_blacklist: Vec::new(),
            transaction_gas_limit: None,
            skip_transaction_gas_limit_for: HashSet::new(),
            allow_local_checkpoint_syncers: true,
            metric_app_contexts: Vec::new(),
            allow_contract_call_caching: true,
            default_ism_cache_config: Default::default(),
            max_retries: 1,
        }
    }

    #[tokio::test]
    #[tracing_test::traced_test]
    async fn test_failed_build_mailboxes() {
        let settings = generate_test_relayer_settings();

        let registry = Registry::new();
        let core_metrics = CoreMetrics::new("relayer", 4000, registry).unwrap();
        let chain_metrics = ChainMetrics {
            block_height: IntGaugeVec::new(
                opts!("block_height", BLOCK_HEIGHT_HELP),
                BLOCK_HEIGHT_LABELS,
            )
            .unwrap(),
            gas_price: None,
            critical_error: IntGaugeVec::new(
                opts!("critical_error", CRITICAL_ERROR_HELP),
                CRITICAL_ERROR_LABELS,
            )
            .unwrap(),
        };

        let mailboxes = Relayer::build_mailboxes(&settings, &core_metrics, &chain_metrics).await;

        assert_eq!(mailboxes.len(), 1);
        assert!(mailboxes.contains_key(&HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum)));

        // Arbitrum chain should not have any errors because it's ChainConf exists
        let metric = chain_metrics
            .critical_error
            .get_metric_with_label_values(&["arbitrum"])
            .unwrap();
        assert_eq!(metric.get(), 0);

        // Ethereum chain should error because it is missing ChainConf
        let metric = chain_metrics
            .critical_error
            .get_metric_with_label_values(&["ethereum"])
            .unwrap();
        assert_eq!(metric.get(), 1);

        // Optimism chain should error because it is missing ChainConf
        let metric = chain_metrics
            .critical_error
            .get_metric_with_label_values(&["optimism"])
            .unwrap();
        assert_eq!(metric.get(), 1);
    }

    #[tokio::test]
    #[tracing_test::traced_test]
    async fn test_failed_build_validator_announces() {
        let settings = generate_test_relayer_settings();

        let registry = Registry::new();
        let core_metrics = CoreMetrics::new("relayer", 4000, registry).unwrap();
        let chain_metrics = ChainMetrics {
            block_height: IntGaugeVec::new(
                opts!("block_height", BLOCK_HEIGHT_HELP),
                BLOCK_HEIGHT_LABELS,
            )
            .unwrap(),
            gas_price: None,
            critical_error: IntGaugeVec::new(
                opts!("critical_error", CRITICAL_ERROR_HELP),
                CRITICAL_ERROR_LABELS,
            )
            .unwrap(),
        };

        let mailboxes =
            Relayer::build_validator_announces(&settings, &core_metrics, &chain_metrics).await;

        assert_eq!(mailboxes.len(), 1);
        assert!(mailboxes.contains_key(&HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum)));

        // Arbitrum chain should not have any errors because it's ChainConf exists
        let metric = chain_metrics
            .critical_error
            .get_metric_with_label_values(&["arbitrum"])
            .unwrap();
        assert_eq!(metric.get(), 0);

        // Ethereum chain should error because it is missing ChainConf
        let metric = chain_metrics
            .critical_error
            .get_metric_with_label_values(&["ethereum"])
            .unwrap();
        assert_eq!(metric.get(), 1);

        // Optimism chain should error because it is missing ChainConf
        let metric = chain_metrics
            .critical_error
            .get_metric_with_label_values(&["optimism"])
            .unwrap();
        assert_eq!(metric.get(), 1);
    }
}
