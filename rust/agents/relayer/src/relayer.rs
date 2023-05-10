use std::fmt::{Debug, Formatter};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use async_trait::async_trait;
use eyre::Result;
use tokio::sync::mpsc::UnboundedSender;
use tokio::{
    sync::{
        mpsc::{self, UnboundedReceiver},
        RwLock,
    },
    task::JoinHandle,
};
use tracing::{info, info_span, instrument::Instrumented, Instrument};

use hyperlane_base::{
    db::{HyperlaneDB, DB},
    run_all, BaseAgent, CachingInterchainGasPaymaster, CachingMailbox, ContractSyncMetrics,
    CoreMetrics, HyperlaneAgentCore,
};
use hyperlane_core::{HyperlaneDomain, U256};

use crate::msg::pending_message::MessageSubmissionMetrics;
use crate::{
    merkle_tree_builder::MerkleTreeBuilder,
    msg::{
        gas_payment::GasPaymentEnforcer,
        metadata::BaseMetadataBuilder,
        pending_message::MessageCtx,
        pending_operation::DynPendingOperation,
        processor::{MessageProcessor, MessageProcessorMetrics},
        serial_submitter::{SerialSubmitter, SerialSubmitterMetrics},
    },
    settings::{matching_list::MatchingList, RelayerSettings},
};

#[derive(Debug, Hash, PartialEq, Eq, Copy, Clone)]
struct ContextKey {
    origin: u32,
    destination: u32,
}

/// A relayer agent
pub struct Relayer {
    origin_chains: HashSet<HyperlaneDomain>,
    destination_chains: HashSet<HyperlaneDomain>,
    core: HyperlaneAgentCore,
    /// Context data for each (origin, destination) chain pair a message can be
    /// sent between
    msg_ctxs: HashMap<ContextKey, Arc<MessageCtx>>,
    /// Mailboxes for all chains (technically only need caching mailbox for
    /// origin chains)
    mailboxes: HashMap<HyperlaneDomain, CachingMailbox>,
    /// Interchain gas paymaster for each origin chain
    interchain_gas_paymasters: HashMap<HyperlaneDomain, CachingInterchainGasPaymaster>,
    prover_syncs: HashMap<HyperlaneDomain, Arc<RwLock<MerkleTreeBuilder>>>,
    whitelist: Arc<MatchingList>,
    blacklist: Arc<MatchingList>,
    transaction_gas_limit: Option<U256>,
    skip_transaction_gas_limit_for: HashSet<u32>,
    allow_local_checkpoint_syncers: bool,
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

impl AsRef<HyperlaneAgentCore> for Relayer {
    fn as_ref(&self) -> &HyperlaneAgentCore {
        &self.core
    }
}

#[async_trait]
#[allow(clippy::unit_arg)]
impl BaseAgent for Relayer {
    const AGENT_NAME: &'static str = "relayer";

    type Settings = RelayerSettings;

    async fn from_settings(settings: Self::Settings, metrics: Arc<CoreMetrics>) -> Result<Self>
    where
        Self: Sized,
    {
        let core = settings.build_hyperlane_core(metrics.clone());
        let db = DB::from_path(&settings.db)?;

        // Use defined origin chains and remote chains
        let domains = settings
            .origin_chains
            .iter()
            .chain(&settings.destination_chains)
            .collect::<HashSet<_>>();

        let mailboxes = settings
            .build_all_mailboxes(domains.into_iter(), &metrics, db.clone())
            .await?;
        let interchain_gas_paymasters = settings
            .build_all_interchain_gas_paymasters(
                settings.origin_chains.iter(),
                &metrics,
                db.clone(),
            )
            .await?;
        let validator_announces = settings
            .build_all_validator_announces(settings.origin_chains.iter(), &metrics)
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
                let db = HyperlaneDB::new(origin, db.clone());
                (
                    origin.clone(),
                    Arc::new(RwLock::new(MerkleTreeBuilder::new(db))),
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
                        HyperlaneDB::new(domain, db.clone()),
                    )),
                )
            })
            .collect();

        let mut msg_ctxs = HashMap::new();
        for destination in &settings.destination_chains {
            let destination_chain_setup = core.settings.chain_setup(destination).unwrap().clone();

            let transaction_gas_limit: Option<U256> =
                if skip_transaction_gas_limit_for.contains(&destination.id()) {
                    None
                } else {
                    transaction_gas_limit
                };

            for origin in &settings.origin_chains {
                let metadata_builder = BaseMetadataBuilder::new(
                    destination_chain_setup.clone(),
                    prover_syncs[origin].clone(),
                    validator_announces[origin].clone(),
                    settings.allow_local_checkpoint_syncers,
                    core.metrics.clone(),
                    5,
                );

                msg_ctxs.insert(
                    ContextKey {
                        origin: origin.id(),
                        destination: destination.id(),
                    },
                    Arc::new(MessageCtx {
                        destination_mailbox: mailboxes[destination].clone(),
                        origin_db: HyperlaneDB::new(origin, db.clone()),
                        metadata_builder,
                        gas_payment_enforcer: gas_payment_enforcers[origin].clone(),
                        transaction_gas_limit,
                        metrics: MessageSubmissionMetrics::new(&metrics, origin, destination),
                    }),
                );
            }
        }

        Ok(Self {
            origin_chains: settings.origin_chains,
            destination_chains: settings.destination_chains,
            msg_ctxs,
            core,
            mailboxes,
            interchain_gas_paymasters,
            prover_syncs,
            whitelist,
            blacklist,
            transaction_gas_limit,
            skip_transaction_gas_limit_for,
            allow_local_checkpoint_syncers: settings.allow_local_checkpoint_syncers,
        })
    }

    #[allow(clippy::async_yields_async)]
    async fn run(&self) -> Instrumented<JoinHandle<Result<()>>> {
        let mut tasks = vec![];

        // send channels by destination chain
        let mut send_channels = HashMap::with_capacity(self.destination_chains.len());
        for destination in &self.destination_chains {
            let (send_channel, receive_channel) =
                mpsc::unbounded_channel::<Box<DynPendingOperation>>();
            send_channels.insert(destination.id(), send_channel);

            tasks.push(self.run_destination_submitter(destination, receive_channel));
        }

        let sync_metrics = ContractSyncMetrics::new(self.core.metrics.clone());
        for origin in &self.origin_chains {
            tasks.push(self.run_origin_mailbox_sync(origin, sync_metrics.clone()));
            tasks.push(self.run_interchain_gas_paymaster_sync(origin, sync_metrics.clone()));
        }

        // each message process attempts to send messages from a chain
        for origin in &self.origin_chains {
            tasks.push(self.run_message_processor(origin, send_channels.clone()));
        }

        run_all(tasks)
    }
}

impl Relayer {
    fn run_origin_mailbox_sync(
        &self,
        origin: &HyperlaneDomain,
        sync_metrics: ContractSyncMetrics,
    ) -> Instrumented<JoinHandle<Result<()>>> {
        let sync = self.mailboxes[origin].sync(
            self.as_ref().settings.chains[origin.name()].index.clone(),
            sync_metrics,
        );
        sync
    }

    fn run_interchain_gas_paymaster_sync(
        &self,
        origin: &HyperlaneDomain,
        sync_metrics: ContractSyncMetrics,
    ) -> Instrumented<JoinHandle<Result<()>>> {
        let sync = self.interchain_gas_paymasters[origin].sync(
            self.as_ref().settings.chains[origin.name()].index.clone(),
            sync_metrics,
        );
        sync
    }

    fn run_message_processor(
        &self,
        origin: &HyperlaneDomain,
        send_channels: HashMap<u32, UnboundedSender<Box<DynPendingOperation>>>,
    ) -> Instrumented<JoinHandle<Result<()>>> {
        let metrics = MessageProcessorMetrics::new(
            &self.core.metrics,
            origin,
            self.destination_chains.iter(),
        );
        let destination_ctxs = self
            .destination_chains
            .iter()
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
            self.mailboxes[origin].db().clone(),
            self.whitelist.clone(),
            self.blacklist.clone(),
            metrics,
            self.prover_syncs[origin].clone(),
            send_channels,
            destination_ctxs,
        );

        let span = info_span!("MessageProcessor", origin=%message_processor.domain());
        let process_fut = message_processor.spawn();
        tokio::spawn(async move {
            let res = tokio::try_join!(process_fut)?;
            info!(?res, "try_join finished for message processor");
            Ok(())
        })
        .instrument(span)
    }

    #[allow(clippy::too_many_arguments)]
    #[tracing::instrument(skip(self, receiver))]
    fn run_destination_submitter(
        &self,
        destination: &HyperlaneDomain,
        receiver: UnboundedReceiver<Box<DynPendingOperation>>,
    ) -> Instrumented<JoinHandle<Result<()>>> {
        let serial_submitter = SerialSubmitter::new(
            destination.clone(),
            receiver,
            SerialSubmitterMetrics::new(&self.core.metrics, destination),
        );
        let span = info_span!("SerialSubmitter", destination=%destination);
        let submit_fut = serial_submitter.spawn();

        tokio::spawn(async move {
            let res = tokio::try_join!(submit_fut)?;
            info!(?res, "try_join finished for submitter");
            Ok(())
        })
        .instrument(span)
    }
}

#[cfg(test)]
mod test {}
