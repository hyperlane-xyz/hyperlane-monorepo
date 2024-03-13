use std::{
    collections::{HashMap, HashSet},
    fmt::{Debug, Formatter},
    sync::Arc,
};

use async_trait::async_trait;
use derive_more::AsRef;
use eyre::Result;
use futures_util::future::try_join_all;
use hyperlane_base::{
    db::{HyperlaneRocksDB, DB},
    metrics::{AgentMetrics, MetricsUpdater},
    settings::ChainConf,
    BaseAgent, ChainMetrics, ContractSyncMetrics, CoreMetrics, HyperlaneAgentCore,
    SequencedDataContractSync, WatermarkContractSync,
};
use hyperlane_core::{
    HyperlaneDomain, HyperlaneMessage, InterchainGasPayment, MerkleTreeInsertion, U256,
};
use tokio::{
    sync::{
        mpsc::{self, UnboundedReceiver, UnboundedSender},
        RwLock,
    },
    task::JoinHandle,
};
use tracing::{info, info_span, instrument::Instrumented, warn, Instrument};

use crate::processor::Processor;
use crate::{
    merkle_tree::builder::MerkleTreeBuilder,
    msg::{
        gas_payment::GasPaymentEnforcer,
        metadata::{BaseMetadataBuilder, IsmAwareAppContextClassifier},
        pending_message::{MessageContext, MessageSubmissionMetrics},
        pending_operation::DynPendingOperation,
        processor::{MessageProcessor, MessageProcessorMetrics},
        serial_submitter::{SerialSubmitter, SerialSubmitterMetrics},
    },
    settings::{matching_list::MatchingList, RelayerSettings},
};
use crate::{
    merkle_tree::processor::{MerkleTreeProcessor, MerkleTreeProcessorMetrics},
    processor::ProcessorExt,
};

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
    message_syncs: HashMap<HyperlaneDomain, Arc<SequencedDataContractSync<HyperlaneMessage>>>,
    interchain_gas_payment_syncs:
        HashMap<HyperlaneDomain, Arc<WatermarkContractSync<InterchainGasPayment>>>,
    /// Context data for each (origin, destination) chain pair a message can be
    /// sent between
    msg_ctxs: HashMap<ContextKey, Arc<MessageContext>>,
    prover_syncs: HashMap<HyperlaneDomain, Arc<RwLock<MerkleTreeBuilder>>>,
    merkle_tree_hook_syncs:
        HashMap<HyperlaneDomain, Arc<SequencedDataContractSync<MerkleTreeInsertion>>>,
    dbs: HashMap<HyperlaneDomain, HyperlaneRocksDB>,
    whitelist: Arc<MatchingList>,
    blacklist: Arc<MatchingList>,
    transaction_gas_limit: Option<U256>,
    skip_transaction_gas_limit_for: HashSet<u32>,
    allow_local_checkpoint_syncers: bool,
    metric_app_contexts: Vec<(MatchingList, String)>,
    core_metrics: Arc<CoreMetrics>,
    // TODO: decide whether to consolidate `agent_metrics` and `chain_metrics` into a single struct
    // or move them in `core_metrics`, like the validator metrics
    agent_metrics: AgentMetrics,
    chain_metrics: ChainMetrics,
}

impl Debug for Relayer {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Relayer {{ origin_chains: {:?}, destination_chains: {:?}, whitelist: {:?}, blacklist: {:?}, transaction_gas_limit: {:?}, skip_transaction_gas_limit_for: {:?}, allow_local_checkpoint_syncers: {:?} }}",
            self.origin_chains,
            self.destination_chains,
            self.whitelist,
            self.blacklist,
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
        settings: Self::Settings,
        core_metrics: Arc<CoreMetrics>,
        agent_metrics: AgentMetrics,
        chain_metrics: ChainMetrics,
    ) -> Result<Self>
    where
        Self: Sized,
    {
        let core = settings.build_hyperlane_core(core_metrics.clone());
        let db = DB::from_path(&settings.db)?;
        let dbs = settings
            .origin_chains
            .iter()
            .map(|origin| (origin.clone(), HyperlaneRocksDB::new(origin, db.clone())))
            .collect::<HashMap<_, _>>();

        let mailboxes = settings
            .build_mailboxes(settings.destination_chains.iter(), &core_metrics)
            .await?;
        let validator_announces = settings
            .build_validator_announces(settings.origin_chains.iter(), &core_metrics)
            .await?;

        let contract_sync_metrics = Arc::new(ContractSyncMetrics::new(&core_metrics));

        let message_syncs = settings
            .build_message_indexers(
                settings.origin_chains.iter(),
                &core_metrics,
                &contract_sync_metrics,
                dbs.iter()
                    .map(|(d, db)| (d.clone(), Arc::new(db.clone()) as _))
                    .collect(),
            )
            .await?;
        let interchain_gas_payment_syncs = settings
            .build_interchain_gas_payment_indexers(
                settings.origin_chains.iter(),
                &core_metrics,
                &contract_sync_metrics,
                dbs.iter()
                    .map(|(d, db)| (d.clone(), Arc::new(db.clone()) as _))
                    .collect(),
            )
            .await?;
        let merkle_tree_hook_syncs = settings
            .build_merkle_tree_hook_indexers(
                settings.origin_chains.iter(),
                &core_metrics,
                &contract_sync_metrics,
                dbs.iter()
                    .map(|(d, db)| (d.clone(), Arc::new(db.clone()) as _))
                    .collect(),
            )
            .await?;

        let whitelist = Arc::new(settings.whitelist);
        let blacklist = Arc::new(settings.blacklist);
        let skip_transaction_gas_limit_for = settings.skip_transaction_gas_limit_for;
        let transaction_gas_limit = settings.transaction_gas_limit;

        info!(
            %whitelist,
            %blacklist,
            ?transaction_gas_limit,
            ?skip_transaction_gas_limit_for,
            "Whitelist configuration"
        );

        // provers by origin chain
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

        info!(gas_enforcement_policies=?settings.gas_payment_enforcement, "Gas enforcement configuration");

        // need one of these per origin chain due to the database scoping even though
        // the config itself is the same
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

        let mut msg_ctxs = HashMap::new();
        let mut destination_chains = HashMap::new();
        for destination in &settings.destination_chains {
            let destination_chain_setup = core.settings.chain_setup(destination).unwrap().clone();
            destination_chains.insert(destination.clone(), destination_chain_setup.clone());
            let transaction_gas_limit: Option<U256> =
                if skip_transaction_gas_limit_for.contains(&destination.id()) {
                    None
                } else {
                    transaction_gas_limit
                };

            for origin in &settings.origin_chains {
                let db = dbs.get(origin).unwrap().clone();
                let metadata_builder = BaseMetadataBuilder::new(
                    origin.clone(),
                    destination_chain_setup.clone(),
                    prover_syncs[origin].clone(),
                    validator_announces[origin].clone(),
                    settings.allow_local_checkpoint_syncers,
                    core.metrics.clone(),
                    db,
                    5,
                    IsmAwareAppContextClassifier::new(
                        mailboxes[destination].clone(),
                        settings.metric_app_contexts.clone(),
                    ),
                );

                msg_ctxs.insert(
                    ContextKey {
                        origin: origin.id(),
                        destination: destination.id(),
                    },
                    Arc::new(MessageContext {
                        destination_mailbox: mailboxes[destination].clone(),
                        origin_db: dbs.get(origin).unwrap().clone(),
                        metadata_builder: Arc::new(metadata_builder),
                        origin_gas_payment_enforcer: gas_payment_enforcers[origin].clone(),
                        transaction_gas_limit,
                        metrics: MessageSubmissionMetrics::new(&core_metrics, origin, destination),
                    }),
                );
            }
        }

        Ok(Self {
            dbs,
            origin_chains: settings.origin_chains,
            destination_chains,
            msg_ctxs,
            core,
            message_syncs,
            interchain_gas_payment_syncs,
            prover_syncs,
            merkle_tree_hook_syncs,
            whitelist,
            blacklist,
            transaction_gas_limit,
            skip_transaction_gas_limit_for,
            allow_local_checkpoint_syncers: settings.allow_local_checkpoint_syncers,
            metric_app_contexts: settings.metric_app_contexts,
            core_metrics,
            agent_metrics,
            chain_metrics,
        })
    }

    #[allow(clippy::async_yields_async)]
    async fn run(self) {
        let mut tasks = vec![];

        // running http server
        let server = self
            .core
            .settings
            .server(self.core_metrics.clone())
            .expect("Failed to create server");
        let server_task = server.run(vec![]).instrument(info_span!("Relayer server"));
        tasks.push(server_task);

        // send channels by destination chain
        let mut send_channels = HashMap::with_capacity(self.destination_chains.len());
        for (dest_domain, dest_conf) in &self.destination_chains {
            let (send_channel, receive_channel) =
                mpsc::unbounded_channel::<Box<DynPendingOperation>>();
            send_channels.insert(dest_domain.id(), send_channel);

            tasks.push(self.run_destination_submitter(dest_domain, receive_channel));

            let metrics_updater = MetricsUpdater::new(
                dest_conf,
                self.core_metrics.clone(),
                self.agent_metrics.clone(),
                self.chain_metrics.clone(),
                Self::AGENT_NAME.to_string(),
            )
            .await
            .unwrap();
            tasks.push(metrics_updater.spawn());
        }

        for origin in &self.origin_chains {
            tasks.push(self.run_message_sync(origin).await);
            tasks.push(self.run_interchain_gas_payment_sync(origin).await);
            tasks.push(self.run_merkle_tree_hook_syncs(origin).await);
        }

        // each message process attempts to send messages from a chain
        for origin in &self.origin_chains {
            tasks.push(self.run_message_processor(origin, send_channels.clone()));
            tasks.push(self.run_merkle_tree_processor(origin));
        }

        if let Err(err) = try_join_all(tasks).await {
            tracing::error!(
                error=?err,
                "Relayer task panicked"
            );
        }
    }
}

impl Relayer {
    async fn run_message_sync(&self, origin: &HyperlaneDomain) -> Instrumented<JoinHandle<()>> {
        let index_settings = self.as_ref().settings.chains[origin.name()].index_settings();
        let contract_sync = self.message_syncs.get(origin).unwrap().clone();
        let cursor = contract_sync
            .forward_backward_message_sync_cursor(index_settings)
            .await;
        tokio::spawn(async move {
            contract_sync
                .clone()
                .sync("dispatched_messages", cursor)
                .await
        })
        .instrument(info_span!("ContractSync"))
    }

    async fn run_interchain_gas_payment_sync(
        &self,
        origin: &HyperlaneDomain,
    ) -> Instrumented<JoinHandle<()>> {
        let index_settings = self.as_ref().settings.chains[origin.name()].index_settings();
        let contract_sync = self
            .interchain_gas_payment_syncs
            .get(origin)
            .unwrap()
            .clone();
        let cursor = contract_sync.rate_limited_cursor(index_settings).await;
        tokio::spawn(async move { contract_sync.clone().sync("gas_payments", cursor).await })
            .instrument(info_span!("ContractSync"))
    }

    async fn run_merkle_tree_hook_syncs(
        &self,
        origin: &HyperlaneDomain,
    ) -> Instrumented<JoinHandle<()>> {
        let index_settings = self.as_ref().settings.chains[origin.name()].index.clone();
        let contract_sync = self.merkle_tree_hook_syncs.get(origin).unwrap().clone();
        let cursor = contract_sync
            .forward_backward_message_sync_cursor(index_settings)
            .await;
        tokio::spawn(async move { contract_sync.clone().sync("merkle_tree_hook", cursor).await })
            .instrument(info_span!("ContractSync"))
    }

    fn run_message_processor(
        &self,
        origin: &HyperlaneDomain,
        send_channels: HashMap<u32, UnboundedSender<Box<DynPendingOperation>>>,
    ) -> Instrumented<JoinHandle<()>> {
        let metrics = MessageProcessorMetrics::new(
            &self.core.metrics,
            origin,
            self.destination_chains.keys(),
        );
        let destination_ctxs: HashMap<_, _> = self
            .destination_chains
            .keys()
            .filter(|&destination| destination != origin)
            .map(|destination| {
                (
                    destination.id(),
                    self.msg_ctxs[&ContextKey {
                        origin: origin.id(),
                        destination: destination.id(),
                    }]
                        .clone(),
                )
            })
            .collect();

        let message_processor = MessageProcessor::new(
            self.dbs.get(origin).unwrap().clone(),
            self.whitelist.clone(),
            self.blacklist.clone(),
            metrics,
            send_channels,
            destination_ctxs,
            self.metric_app_contexts.clone(),
        );

        let span = info_span!("MessageProcessor", origin=%message_processor.domain());
        let processor = Processor::new(Box::new(message_processor));

        processor.spawn().instrument(span)
    }

    fn run_merkle_tree_processor(&self, origin: &HyperlaneDomain) -> Instrumented<JoinHandle<()>> {
        let metrics = MerkleTreeProcessorMetrics::new();
        let merkle_tree_processor = MerkleTreeProcessor::new(
            self.dbs.get(origin).unwrap().clone(),
            metrics,
            self.prover_syncs[origin].clone(),
        );

        let span = info_span!("MerkleTreeProcessor", origin=%merkle_tree_processor.domain());
        let processor = Processor::new(Box::new(merkle_tree_processor));
        processor.spawn().instrument(span)
    }

    #[allow(clippy::too_many_arguments)]
    #[tracing::instrument(skip(self, receiver))]
    fn run_destination_submitter(
        &self,
        destination: &HyperlaneDomain,
        receiver: UnboundedReceiver<Box<DynPendingOperation>>,
    ) -> Instrumented<JoinHandle<()>> {
        let serial_submitter = SerialSubmitter::new(
            destination.clone(),
            receiver,
            SerialSubmitterMetrics::new(&self.core.metrics, destination),
        );
        let span = info_span!("SerialSubmitter", destination=%destination);
        let destination = destination.clone();
        tokio::spawn(async move {
            // Propagate task panics
            serial_submitter.spawn().await.unwrap_or_else(|err| {
                panic!(
                    "destination submitter panicked for destination {}: {:?}",
                    destination, err
                )
            });
        })
        .instrument(span)
    }
}

#[cfg(test)]
mod test {}
