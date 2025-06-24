use std::{
    collections::{HashMap, HashSet},
    fmt::{Debug, Formatter},
    hash::Hash,
    sync::Arc,
    time::Instant,
};

use async_trait::async_trait;
use derive_more::AsRef;
use eyre::{eyre, Result};
use futures::future::join_all;
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
    cursors::Indexable,
    db::{HyperlaneRocksDB, DB},
    metrics::{AgentMetrics, ChainSpecificMetricsUpdater},
    settings::{ChainConf, IndexSettings, SequenceIndexer, TryFromWithMetrics},
    AgentMetadata, BaseAgent, ChainMetrics, ContractSyncMetrics, ContractSyncer, CoreMetrics,
    HyperlaneAgentCore, RuntimeMetrics, SyncOptions,
};
use hyperlane_core::{
    rpc_clients::call_and_retry_n_times, ChainCommunicationError, ChainResult, ContractSyncCursor,
    HyperlaneDomain, HyperlaneDomainProtocol, HyperlaneLogStore, HyperlaneMessage,
    HyperlaneSequenceAwareIndexerStoreReader, HyperlaneWatermarkedLogStore, InterchainGasPayment,
    Mailbox, MerkleTreeInsertion, QueueOperation, SubmitterType, ValidatorAnnounce, H512, U256,
};
use hyperlane_operation_verifier::ApplicationOperationVerifier;
use lander::{
    DatabaseOrPath, Dispatcher, DispatcherEntrypoint, DispatcherMetrics, DispatcherSettings,
};

use crate::{
    merkle_tree::builder::MerkleTreeBuilder,
    metrics::message_submission::MessageSubmissionMetrics,
    msg::{
        blacklist::AddressBlacklist,
        gas_payment::GasPaymentEnforcer,
        metadata::{
            BaseMetadataBuilder, DefaultIsmCache, IsmAwareAppContextClassifier,
            IsmCachePolicyClassifier,
        },
        op_submitter::{SerialSubmitter, SerialSubmitterMetrics},
        pending_message::MessageContext,
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
const ADVANCED_LOG_META: bool = false;

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
        Option<HashMap<HyperlaneDomain, Arc<dyn ContractSyncer<InterchainGasPayment>>>>,
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
    payload_dispatcher_entrypoints: HashMap<HyperlaneDomain, DispatcherEntrypoint>,
    payload_dispatchers: HashMap<HyperlaneDomain, Dispatcher>,
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
        let dispatcher_metrics = DispatcherMetrics::new(core_metrics.registry())
            .expect("Creating dispatcher metrics is infallible");
        let dispatcher_entrypoints = Self::build_payload_dispatcher_entrypoints(
            &settings,
            core_metrics.clone(),
            &chain_metrics,
            dispatcher_metrics.clone(),
            db.clone(),
        )
        .await;
        debug!(elapsed = ?start_entity_init.elapsed(), event = "initialized dispatcher entrypoints", "Relayer startup duration measurement");

        start_entity_init = Instant::now();
        let dispatchers = Self::build_payload_dispatchers(
            &settings,
            core_metrics.clone(),
            &chain_metrics,
            dispatcher_metrics,
            db.clone(),
        )
        .await;
        debug!(elapsed = ?start_entity_init.elapsed(), event = "initialized dipatchers", "Relayer startup duration measurement");

        let contract_sync_metrics = Arc::new(ContractSyncMetrics::new(&core_metrics));

        start_entity_init = Instant::now();

        let stores: HashMap<_, _> = dbs
            .iter()
            .map(|(d, db)| (d.clone(), Arc::new(db.clone())))
            .collect();

        let message_syncs = Self::build_contract_syncs(
            &settings,
            &core_metrics,
            &chain_metrics,
            &contract_sync_metrics,
            stores.clone(),
            "message",
        )
        .await;

        debug!(elapsed = ?start_entity_init.elapsed(), event = "initialized message syncs", "Relayer startup duration measurement");

        start_entity_init = Instant::now();
        let interchain_gas_payment_syncs = if settings.igp_indexing_enabled {
            let igp_syncs = Self::build_contract_syncs(
                &settings,
                &core_metrics,
                &chain_metrics,
                &contract_sync_metrics,
                stores.clone(),
                "interchain gas payments",
            )
            .await;
            Some(igp_syncs)
        } else {
            None
        };
        debug!(elapsed = ?start_entity_init.elapsed(), event = "initialized IGP syncs", "Relayer startup duration measurement");

        start_entity_init = Instant::now();
        let merkle_tree_hook_syncs = Self::build_contract_syncs(
            &settings,
            &core_metrics,
            &chain_metrics,
            &contract_sync_metrics,
            stores.clone(),
            "merkle tree hook syncs",
        )
        .await;

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
            .filter_map(|domain| match dbs.get(domain) {
                Some(db) => {
                    let gas_payment_enforcer = Arc::new(RwLock::new(GasPaymentEnforcer::new(
                        settings.gas_payment_enforcement.clone(),
                        db.clone(),
                    )));
                    Some((domain.clone(), gas_payment_enforcer))
                }
                None => {
                    tracing::error!(?domain, "Missing DB");
                    None
                }
            })
            .collect();
        debug!(elapsed = ?start_entity_init.elapsed(), event = "initialized gas payment enforcers", "Relayer startup duration measurement");

        let mut msg_ctxs = HashMap::new();

        start_entity_init = Instant::now();

        // only iterate through destination chains that were successfully instantiated
        let mut ccip_signer_futures: Vec<_> = Vec::with_capacity(mailboxes.len());
        for destination in mailboxes.keys() {
            let destination_chain_setup = match core.settings.chain_setup(destination) {
                Ok(setup) => setup.clone(),
                Err(err) => {
                    tracing::error!(?destination, ?err, "Destination chain setup failed");
                    continue;
                }
            };
            let signer = destination_chain_setup.signer.clone();
            let future = async move {
                if !matches!(
                    destination.domain_protocol(),
                    HyperlaneDomainProtocol::Ethereum
                ) {
                    return (destination, None);
                }
                let signer = if let Some(builder) = signer {
                    match builder.build::<hyperlane_ethereum::Signers>().await {
                        Ok(signer) => Some(signer),
                        Err(err) => {
                            warn!(error = ?err, "Failed to build Ethereum signer for CCIP-read ISM. ");
                            None
                        }
                    }
                } else {
                    None
                };
                (destination, signer)
            };
            ccip_signer_futures.push(future);
        }
        let ccip_signers = join_all(ccip_signer_futures)
            .await
            .into_iter()
            .collect::<HashMap<_, _>>();

        let mut destination_chains = HashMap::new();
        for (destination, dest_mailbox) in mailboxes.iter() {
            let destination_chain_setup = match core.settings.chain_setup(destination) {
                Ok(setup) => setup.clone(),
                Err(err) => {
                    tracing::error!(?destination, ?err, "Destination chain setup failed");
                    continue;
                }
            };
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
                let db = match dbs.get(origin) {
                    Some(db) => db.clone(),
                    None => {
                        tracing::error!(origin=?origin.name(), "DB missing");
                        continue;
                    }
                };
                let default_ism_getter = DefaultIsmCache::new(dest_mailbox.clone());
                let origin_chain_setup = match core.settings.chain_setup(origin) {
                    Ok(chain_setup) => chain_setup.clone(),
                    Err(err) => {
                        tracing::error!(origin=?origin.name(), ?err, "Origin chain setup failed");
                        continue;
                    }
                };
                // Extract optional Ethereum signer for CCIP-read authentication
                let metadata_builder = BaseMetadataBuilder::new(
                    origin.clone(),
                    destination_chain_setup.clone(),
                    prover_syncs[origin].clone(),
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
                    ccip_signers.get(destination).cloned().flatten(),
                    origin_chain_setup.ignore_reorg_reports,
                );

                msg_ctxs.insert(
                    ContextKey {
                        origin: origin.id(),
                        destination: destination.id(),
                    },
                    Arc::new(MessageContext {
                        origin: origin.clone(),
                        destination_mailbox: dest_mailbox.clone(),
                        origin_db: Arc::new(db),
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

            let db = match self.dbs.get(dest_domain) {
                Some(db) => db.clone(),
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
                .get(dest_domain.name())
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
                    .get(dest_domain.name())
                    .and_then(|chain| {
                        chain
                            .connection
                            .operation_submission_config()
                            .and_then(|c| c.max_submit_queue_length)
                    });
            let serial_submitter = SerialSubmitter::new(
                dest_domain.clone(),
                receive_channel,
                &sender,
                SerialSubmitterMetrics::new(&self.core.metrics, dest_domain),
                max_batch_size,
                max_submit_queue_len,
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

            let message_sync = match self.run_message_sync(origin, task_monitor.clone()).await {
                Ok(task) => task,
                Err(err) => {
                    Self::record_critical_error(
                        origin,
                        &self.chain_metrics,
                        &err,
                        "Failed to run message sync",
                    );
                    continue;
                }
            };
            tasks.push(message_sync);

            if let Some(interchain_gas_payment_syncs) = &self.interchain_gas_payment_syncs {
                tasks.push(
                    self.run_interchain_gas_payment_sync(
                        origin,
                        interchain_gas_payment_syncs,
                        BroadcastMpscSender::map_get_receiver(maybe_broadcaster.as_ref()).await,
                        task_monitor.clone(),
                    )
                    .await,
                );
            }
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

        // create a db mapping for server handlers
        let dbs: HashMap<u32, HyperlaneRocksDB> =
            self.dbs.iter().map(|(k, v)| (k.id(), v.clone())).collect();

        let gas_enforcers: HashMap<_, _> = self
            .msg_ctxs
            .values()
            .map(|ctx| (ctx.origin.clone(), ctx.origin_gas_payment_enforcer.clone()))
            .collect();
        let relayer_router = relayer_server::Server::new(self.destination_chains.len())
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
        origin: &HyperlaneDomain,
        chain_metrics: &ChainMetrics,
        err: &impl Debug,
        message: &str,
    ) {
        error!(?err, origin=?origin.name(), "{message}");
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
            None,
        )
        .await
    }

    async fn run_message_sync(
        &self,
        origin: &HyperlaneDomain,
        task_monitor: TaskMonitor,
    ) -> Result<JoinHandle<()>> {
        let origin = origin.clone();
        let contract_sync = self
            .message_syncs
            .get(&origin)
            .cloned()
            .ok_or_else(|| eyre!("Missing message sync"))?;
        let index_settings = self.as_ref().settings.chains[origin.name()].index_settings();
        let chain_metrics = self.chain_metrics.clone();

        let name = Self::contract_sync_task_name("message::", origin.name());
        let task = tokio::task::Builder::new()
            .name(&name)
            .spawn(TaskMonitor::instrument(
                &task_monitor,
                async move {
                    Self::message_sync_task(&origin, contract_sync, index_settings, chain_metrics)
                        .await;
                }
                .instrument(info_span!("MessageSync")),
            ))?;
        Ok(task)
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
        origin: &HyperlaneDomain,
        interchain_gas_payment_syncs: &HashMap<
            HyperlaneDomain,
            Arc<dyn ContractSyncer<InterchainGasPayment>>,
        >,
        tx_id_receiver: Option<MpscReceiver<H512>>,
        task_monitor: TaskMonitor,
    ) -> JoinHandle<()> {
        let origin = origin.clone();
        let index_settings = self.as_ref().settings.chains[origin.name()].index_settings();
        let contract_sync = interchain_gas_payment_syncs.get(&origin).unwrap().clone();
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
                        &self.chain_metrics,
                        &ChainCommunicationError::CustomError(err_msg.clone()),
                        &err_msg,
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
                    Self::record_critical_error(
                        &origin,
                        chain_metrics,
                        &err,
                        "Critical error when building mailbox",
                    );
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
        dispatcher_metrics: DispatcherMetrics,
        db: DB,
    ) -> HashMap<HyperlaneDomain, DispatcherEntrypoint> {
        let entrypoint_futures: Vec<_> = settings
            .destination_chains
            .iter()
            .filter(|chain| {
                settings
                    .chains
                    .get(&chain.to_string())
                    .map(|chain| chain.submitter == SubmitterType::Lander)
                    .unwrap_or(false)
            })
            .map(|chain| {
                (
                    chain.clone(),
                    DispatcherSettings {
                        chain_conf: settings.chains[&chain.to_string()].clone(),
                        raw_chain_conf: Default::default(),
                        domain: chain.clone(),
                        db: DatabaseOrPath::Database(db.clone()),
                        metrics: core_metrics.clone(),
                    },
                )
            })
            .map(|(chain, s)| async {
                (
                    chain,
                    DispatcherEntrypoint::try_from_settings(s, dispatcher_metrics.clone()).await,
                )
            })
            .collect();
        let results = futures::future::join_all(entrypoint_futures).await;
        results
            .into_iter()
            .filter_map(|(chain, result)| match result {
                Ok(entrypoint) => Some((chain, entrypoint)),
                Err(err) => {
                    Self::record_critical_error(
                        &chain,
                        chain_metrics,
                        &err,
                        "Critical error when building payload dispatcher endpoint",
                    );
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
        dispatcher_metrics: DispatcherMetrics,
        db: DB,
    ) -> HashMap<HyperlaneDomain, Dispatcher> {
        let dispatcher_futures: Vec<_> = settings
            .destination_chains
            .iter()
            .filter(|chain| {
                settings
                    .chains
                    .get(&chain.to_string())
                    .map(|chain| chain.submitter == SubmitterType::Lander)
                    .unwrap_or(false)
            })
            .map(|chain| {
                (
                    chain.clone(),
                    DispatcherSettings {
                        chain_conf: settings.chains[&chain.to_string()].clone(),
                        raw_chain_conf: Default::default(),
                        domain: chain.clone(),
                        db: DatabaseOrPath::Database(db.clone()),
                        metrics: core_metrics.clone(),
                    },
                )
            })
            .map(|(chain, s)| async {
                let chain_name = chain.to_string();
                (
                    chain,
                    Dispatcher::try_from_settings(s, chain_name, dispatcher_metrics.clone()).await,
                )
            })
            .collect();
        let results = futures::future::join_all(dispatcher_futures).await;
        results
            .into_iter()
            .filter_map(|(chain, result)| match result {
                Ok(entrypoint) => Some((chain, entrypoint)),
                Err(err) => {
                    Self::record_critical_error(
                        &chain,
                        chain_metrics,
                        &err,
                        "Critical error when building payload dispatcher",
                    );
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
                    Self::record_critical_error(
                        &origin,
                        chain_metrics,
                        &err,
                        "Critical error when building validator announce",
                    );
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
            .filter_map(
                |(origin, app_context_verifier_res)| match app_context_verifier_res {
                    Ok(app_context_verifier) => Some((origin, app_context_verifier)),
                    Err(err) => {
                        Self::record_critical_error(
                            &origin,
                            chain_metrics,
                            &err,
                            "Critical error when building application operation verifier",
                        );
                        None
                    }
                },
            )
            .collect()
    }

    pub async fn build_contract_syncs<T, S>(
        settings: &RelayerSettings,
        core_metrics: &CoreMetrics,
        chain_metrics: &ChainMetrics,
        contract_sync_metrics: &ContractSyncMetrics,
        stores: HashMap<HyperlaneDomain, Arc<S>>,
        data_type: &str,
    ) -> HashMap<HyperlaneDomain, Arc<dyn ContractSyncer<T>>>
    where
        T: Indexable + Debug + Send + Sync + Clone + Eq + Hash + 'static,
        SequenceIndexer<T>: TryFromWithMetrics<ChainConf>,
        S: HyperlaneLogStore<T>
            + HyperlaneSequenceAwareIndexerStoreReader<T>
            + HyperlaneWatermarkedLogStore<T>
            + 'static,
    {
        settings
            .contract_syncs(
                core_metrics,
                contract_sync_metrics,
                stores,
                ADVANCED_LOG_META,
                settings.tx_id_indexing_enabled,
            )
            .await
            .into_iter()
            .filter_map(|(domain, sync)| match sync {
                Ok(s) => Some((domain, s)),
                Err(err) => {
                    Self::record_critical_error(
                        &domain,
                        chain_metrics,
                        &err,
                        &format!("Critical error when building {data_type} contract sync"),
                    );
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
        path::Path,
        time::Duration,
    };

    use ethers::utils::hex;
    use ethers_prometheus::middleware::PrometheusMiddlewareConf;
    use eyre::eyre;
    use prometheus::{opts, IntGaugeVec, Registry};
    use reqwest::Url;

    use hyperlane_base::{
        settings::{
            ChainConf, ChainConnectionConf, CoreContractAddresses, IndexSettings, Settings,
            SignerConf, TracingConfig,
        },
        AgentMetadata, AgentMetrics, BaseAgent, ChainMetrics, CoreMetrics, RuntimeMetrics,
        BLOCK_HEIGHT_HELP, BLOCK_HEIGHT_LABELS, CRITICAL_ERROR_HELP, CRITICAL_ERROR_LABELS,
    };
    use hyperlane_core::{
        config::OpSubmissionConfig, HyperlaneDomain, IndexMode, KnownHyperlaneDomain, ReorgPeriod,
        H256,
    };
    use hyperlane_ethereum as h_eth;
    use tokio::time::error::Elapsed;

    use crate::settings::{matching_list::MatchingList, RelayerSettings};

    use super::Relayer;

    fn generate_test_core_contract_addresses() -> CoreContractAddresses {
        CoreContractAddresses {
            mailbox: H256::from_slice(
                hex::decode("000000000000000000000000598facE78a4302f11E3de0bee1894Da0b2Cb71F8")
                    .unwrap()
                    .as_slice(),
            ),
            interchain_gas_paymaster: H256::from_slice(
                hex::decode("000000000000000000000000c756cFc1b7d0d4646589EDf10eD54b201237F5e8")
                    .unwrap()
                    .as_slice(),
            ),
            validator_announce: H256::from_slice(
                hex::decode("0000000000000000000000001b33611fCc073aB0737011d5512EF673Bff74962")
                    .unwrap()
                    .as_slice(),
            ),
            merkle_tree_hook: H256::from_slice(
                hex::decode("000000000000000000000000AD34A66Bf6dB18E858F6B686557075568c6E031C")
                    .unwrap()
                    .as_slice(),
            ),
        }
    }

    fn generate_test_chain_conf(
        domain: HyperlaneDomain,
        signer: Option<SignerConf>,
        rpc: &str,
    ) -> ChainConf {
        ChainConf {
            domain,
            signer,
            submitter: Default::default(),
            estimated_block_time: Duration::from_secs_f64(1.1),
            reorg_period: ReorgPeriod::None,
            addresses: generate_test_core_contract_addresses(),
            connection: ChainConnectionConf::Ethereum(h_eth::ConnectionConf {
                rpc_connection: h_eth::RpcConnectionConf::Http {
                    url: Url::parse(rpc).unwrap(),
                },
                transaction_overrides: h_eth::TransactionOverrides {
                    gas_price: None,
                    gas_limit: None,
                    max_fee_per_gas: None,
                    max_priority_fee_per_gas: None,
                    ..Default::default()
                },
                op_submission_config: OpSubmissionConfig {
                    batch_contract_address: None,
                    max_batch_size: 1,
                    ..Default::default()
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
            ignore_reorg_reports: false,
        }
    }

    /// Builds a test RelayerSetting
    fn generate_test_relayer_settings(
        db_path: &Path,
        chains: Vec<(String, ChainConf)>,
        origin_chains: &[HyperlaneDomain],
        destination_chains: &[HyperlaneDomain],
        metrics_port: u16,
    ) -> RelayerSettings {
        RelayerSettings {
            base: Settings {
                chains: chains.into_iter().collect(),
                metrics_port,
                tracing: TracingConfig::default(),
            },
            db: db_path.to_path_buf(),
            origin_chains: origin_chains.iter().cloned().collect(),
            destination_chains: destination_chains.iter().cloned().collect(),
            gas_payment_enforcement: Vec::new(),
            whitelist: MatchingList::default(),
            blacklist: MatchingList::default(),
            address_blacklist: Vec::new(),
            transaction_gas_limit: None,
            skip_transaction_gas_limit_for: HashSet::new(),
            allow_local_checkpoint_syncers: true,
            metric_app_contexts: Vec::new(),
            allow_contract_call_caching: true,
            ism_cache_configs: Default::default(),
            max_retries: 1,
            tx_id_indexing_enabled: true,
            igp_indexing_enabled: true,
        }
    }

    #[tokio::test]
    #[tracing_test::traced_test]
    async fn test_failed_build_mailboxes() {
        let temp_dir = tempfile::tempdir().unwrap();
        let db_path = temp_dir.path();

        let chains = vec![
            (
                KnownHyperlaneDomain::Arbitrum.to_string(),
                generate_test_chain_conf(
                    HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
                    None,
                    // these urls are not expected to be live
                    "http://localhost:8545",
                ),
            ),
            (
                KnownHyperlaneDomain::Ethereum.to_string(),
                generate_test_chain_conf(
                    HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
                    None,
                    // these urls are not expected to be live
                    "http://localhost:8545",
                ),
            ),
        ];
        let origin_chains = &[
            HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism),
        ];
        let destination_chains = &[
            HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism),
        ];
        let metrics_port = 27001;
        let settings = generate_test_relayer_settings(
            db_path,
            chains,
            origin_chains,
            destination_chains,
            metrics_port,
        );

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

        assert_eq!(mailboxes.len(), 2);
        assert!(mailboxes.contains_key(&HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum)));
        assert!(mailboxes.contains_key(&HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum)));

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
        assert_eq!(metric.get(), 0);

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
        let temp_dir = tempfile::tempdir().unwrap();
        let db_path = temp_dir.path();

        let chains = vec![(
            KnownHyperlaneDomain::Arbitrum.to_string(),
            generate_test_chain_conf(
                HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
                None,
                // these urls are not expected to be live
                "http://localhost:8545",
            ),
        )];
        let origin_chains = &[
            HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism),
        ];
        let destination_chains = &[
            HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism),
        ];
        let metrics_port = 27002;
        let settings = generate_test_relayer_settings(
            db_path,
            chains,
            origin_chains,
            destination_chains,
            metrics_port,
        );

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

    async fn build_relayer(settings: RelayerSettings) -> eyre::Result<Relayer> {
        let agent_metadata = AgentMetadata::new("relayer_git_hash".into());

        let metrics = settings.as_ref().metrics("relayer")?;
        let task_monitor = tokio_metrics::TaskMonitor::new();
        let agent_metrics = AgentMetrics::new(&metrics)?;
        let chain_metrics = ChainMetrics::new(&metrics)?;
        let runtime_metrics = RuntimeMetrics::new(&metrics, task_monitor)?;

        let (_, tokio_server) = console_subscriber::ConsoleLayer::new();

        Relayer::from_settings(
            agent_metadata,
            settings,
            metrics,
            agent_metrics,
            chain_metrics,
            runtime_metrics,
            tokio_server,
        )
        .await
    }

    async fn check_relayer_metrics(agent: Relayer, metrics_port: u16, chain_count: u32) {
        let _ = tokio::task::spawn(async move {
            agent.run().await;
        });

        let metrics_url = format!("http://localhost:{metrics_port}/metrics");
        let sleep_duration = Duration::from_secs(3);
        let metrics = "hyperlane_critical_error";
        loop {
            let res = reqwest::get(&metrics_url).await;
            let response = match res {
                Ok(s) => s,
                _ => {
                    tokio::time::sleep(sleep_duration).await;
                    continue;
                }
            };

            let status = response.status();
            if status.is_success() {
                if let Ok(body) = response.text().await {
                    let matched_lines: eyre::Result<Vec<u32>> = body
                        .lines()
                        .filter(|l| l.starts_with(metrics))
                        .map(|l| {
                            let value = l.rsplit_once(' ').ok_or(eyre!("Unknown metric format"))?.1;
                            Ok(value.parse::<u32>()?)
                        })
                        .collect();
                    let failed_chain_count: u32 = matched_lines.unwrap_or_default().iter().sum();

                    if failed_chain_count == chain_count {
                        break;
                    }
                }
            }
            tokio::time::sleep(sleep_duration).await;
        }
    }

    /// Run relayer for 50s to ensure it doesn't crash
    async fn test_relayer_started_successfully(
        agent: Relayer,
        metrics_port: u16,
        failed_chain_count: u32,
    ) -> Result<(), Elapsed> {
        let future = check_relayer_metrics(agent, metrics_port, failed_chain_count);
        tokio::time::timeout(Duration::from_secs(50), future).await
    }

    #[tracing_test::traced_test]
    #[tokio::test]
    async fn test_from_settings_and_run_happy_path() {
        let temp_dir = tempfile::tempdir().unwrap();
        let db_path = temp_dir.path();
        let chains = vec![(
            "arbitrum".to_string(),
            generate_test_chain_conf(
                HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
                None,
                // these urls are not expected to be live
                "http://localhost:8545",
            ),
        )];
        let origin_chains = &[HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum)];
        let destination_chains = &[HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum)];
        let metrics_port = 27003;
        let settings = generate_test_relayer_settings(
            db_path,
            chains,
            origin_chains,
            destination_chains,
            metrics_port,
        );

        let agent = build_relayer(settings)
            .await
            .expect("Failed to build relayer");

        let failed_chain_count = 1;
        assert!(
            test_relayer_started_successfully(agent, metrics_port, failed_chain_count)
                .await
                .is_ok()
        );
    }

    #[tracing_test::traced_test]
    #[tokio::test]
    async fn test_from_settings_and_run_missing_chain_configs() {
        let temp_dir = tempfile::tempdir().unwrap();
        let db_path = temp_dir.path();
        let chains = vec![(
            "arbitrum".to_string(),
            generate_test_chain_conf(
                HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
                None,
                // these urls are not expected to be live
                "http://localhost:8545",
            ),
        )];
        let origin_chains = &[
            HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism),
        ];
        let destination_chains = &[
            HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism),
        ];
        let metrics_port = 27004;
        let settings = generate_test_relayer_settings(
            db_path,
            chains,
            origin_chains,
            destination_chains,
            metrics_port,
        );

        let agent = build_relayer(settings)
            .await
            .expect("Failed to build relayer");

        let failed_chain_count = 3;
        assert!(
            test_relayer_started_successfully(agent, metrics_port, failed_chain_count)
                .await
                .is_ok()
        );
    }

    #[tracing_test::traced_test]
    #[tokio::test]
    async fn test_from_settings_and_run_bad_rpc() {
        let temp_dir = tempfile::tempdir().unwrap();
        let db_path = temp_dir.path();

        let chains = vec![(
            KnownHyperlaneDomain::Arbitrum.to_string(),
            generate_test_chain_conf(
                HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
                None,
                // these urls are not expected to be live
                "http://localhost:9999/rpc",
            ),
        )];
        let origin_chains = &[HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum)];
        let destination_chains = &[HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum)];
        let metrics_port = 27005;
        let settings = generate_test_relayer_settings(
            db_path,
            chains,
            origin_chains,
            destination_chains,
            metrics_port,
        );

        let agent = build_relayer(settings)
            .await
            .expect("Failed to build relayer");

        let failed_chain_count = 1;
        assert!(
            test_relayer_started_successfully(agent, metrics_port, failed_chain_count)
                .await
                .is_ok()
        );
    }

    #[tracing_test::traced_test]
    #[tokio::test]
    async fn test_from_settings_and_run_less_destinations() {
        let temp_dir = tempfile::tempdir().unwrap();
        let db_path = temp_dir.path();

        let chains = vec![
            (
                KnownHyperlaneDomain::Arbitrum.to_string(),
                generate_test_chain_conf(
                    HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
                    None,
                    // these urls are not expected to be live
                    "http://localhost:8545",
                ),
            ),
            (
                KnownHyperlaneDomain::Ethereum.to_string(),
                generate_test_chain_conf(
                    HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
                    None,
                    // these urls are not expected to be live
                    "http://localhost:8545",
                ),
            ),
        ];
        let origin_chains = &[
            HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism),
        ];
        let destination_chains = &[HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum)];
        let metrics_port = 27006;
        let settings = generate_test_relayer_settings(
            db_path,
            chains,
            origin_chains,
            destination_chains,
            metrics_port,
        );

        let agent = build_relayer(settings)
            .await
            .expect("Failed to build relayer");

        let failed_chain_count = 3;
        assert!(
            test_relayer_started_successfully(agent, metrics_port, failed_chain_count)
                .await
                .is_ok()
        );
    }

    #[tracing_test::traced_test]
    #[tokio::test]
    async fn test_from_settings_and_run_bad_signer() {
        let temp_dir = tempfile::tempdir().unwrap();
        let db_path = temp_dir.path();
        let chains = vec![(
            "arbitrum".to_string(),
            generate_test_chain_conf(
                HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
                Some(SignerConf::HexKey { key: H256::zero() }),
                // these urls are not expected to be live
                "http://localhost:8545",
            ),
        )];
        let origin_chains = &[HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum)];
        let destination_chains = &[HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum)];
        let metrics_port = 27007;
        let settings = generate_test_relayer_settings(
            db_path,
            chains,
            origin_chains,
            destination_chains,
            metrics_port,
        );

        let agent = build_relayer(settings)
            .await
            .expect("Failed to build relayer");

        let failed_chain_count = 1;
        assert!(
            test_relayer_started_successfully(agent, metrics_port, failed_chain_count)
                .await
                .is_ok()
        );
    }
}
