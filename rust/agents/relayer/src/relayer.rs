use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use async_trait::async_trait;
use eyre::Result;
use itertools::Itertools;
use tokio::sync::{
    mpsc::{self, UnboundedReceiver, UnboundedSender},
    RwLock,
};
use tokio::task::JoinHandle;
use tracing::{info, info_span, instrument::Instrumented, Instrument};

use hyperlane_base::db::HyperlaneDB;
use hyperlane_base::{
    db::DB, run_all, BaseAgent, CachingInterchainGasPaymaster, CachingMailbox, ContractSyncMetrics,
    CoreMetrics, HyperlaneAgentCore,
};
use hyperlane_core::{HyperlaneChain, HyperlaneDomain, ValidatorAnnounce, U256};

use crate::{
    merkle_tree_builder::MerkleTreeBuilder,
    msg::{
        gas_payment::GasPaymentEnforcer,
        metadata::BaseMetadataBuilder,
        processor::{MessageProcessor, MessageProcessorMetrics},
        serial_submitter::{SerialSubmitter, SerialSubmitterMetrics},
        pending_message::PendingMessage,
    },
    settings::{matching_list::MatchingList, RelayerSettings},
};

/// A relayer agent
#[derive(Debug)]
pub struct Relayer {
    origin_chains: HashSet<HyperlaneDomain>,
    destination_chains: HashSet<HyperlaneDomain>,
    core: HyperlaneAgentCore,
    /// The base database not scoped to a specific domain
    db: DB,
    // TODO: use u32 instead of domain?
    /// Mailboxes for all chains (technically only need caching mailbox for
    /// origin chains)
    mailboxes: HashMap<HyperlaneDomain, CachingMailbox>,
    /// Interchain gas paymaster for each origin chain
    interchain_gas_paymasters: HashMap<HyperlaneDomain, CachingInterchainGasPaymaster>,
    /// Validator announce for each origin chain
    validator_announces: HashMap<HyperlaneDomain, Arc<dyn ValidatorAnnounce>>,
    /// Gas payment enforcer for each origin chain
    gas_payment_enforcers: HashMap<HyperlaneDomain, Arc<GasPaymentEnforcer>>,
    whitelist: Arc<MatchingList>,
    blacklist: Arc<MatchingList>,
    transaction_gas_limit: Option<U256>,
    skip_transaction_gas_limit_for: HashSet<u32>,
    allow_local_checkpoint_syncers: bool,
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
            .build_all_interchain_gas_paymasters(settings.origin_chains.iter(), &metrics, db)
            .await?;
        let validator_announces = settings
            .build_all_validator_announces(settings.origin_chains.iter(), &core.metrics.clone())
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

        info!(gas_enforcement_policies=?settings.gas_payment_enforcement, "Gas enforcement configuration");
        // need one of these per origin chain due to the database scoping even though
        // the config itself is the same
        let gas_payment_enforcers = settings
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

        Ok(Self {
            origin_chains: settings.origin_chains,
            destination_chains: settings.destination_chains,
            db,
            core,
            mailboxes,
            validator_announces,
            interchain_gas_paymasters,
            gas_payment_enforcers,
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

        // provers by origin chain
        let provers_sync = self
            .origin_chains
            .iter()
            .map(|origin| {
                let db = HyperlaneDB::new(origin, self.db.clone());
                (
                    origin.clone(),
                    Arc::new(RwLock::new(MerkleTreeBuilder::new(db))),
                )
            })
            .collect::<HashMap<_, _>>();

        // send channels by destination chain
        let mut send_channels: HashMap<u32, UnboundedSender<PendingMessage>> =
            HashMap::with_capacity(self.destination_chains.len());
        for destination in &self.destination_chains {
            let (send_channel, receive_channel): (
                UnboundedSender<PendingMessage>,
                UnboundedReceiver<PendingMessage>,
            ) = mpsc::unbounded_channel();
            send_channels.insert(destination.id(), send_channel);

            let chain_setup = self
                .core
                .settings
                .chain_setup(destination)
                .unwrap_or_else(|_| panic!("No chain setup found for {}", destination.name()))
                .clone();

            let metadata_builders = self
                .origin_chains
                .iter()
                .map(|origin| {
                    (
                        origin.clone(),
                        BaseMetadataBuilder::new(
                            chain_setup,
                            provers_sync[origin].clone(),
                            self.validator_announces[origin].clone(),
                            self.allow_local_checkpoint_syncers,
                            self.core.metrics.clone(),
                            5,
                        ),
                    )
                })
                .collect();

            tasks.push(self.run_destination_mailbox(
                self.mailboxes[destination].clone(),
                metadata_builders,
                receive_channel,
            ));
        }

        let sync_metrics = ContractSyncMetrics::new(self.core.metrics.clone());
        for origin in self.origin_chains {
            tasks.push(self.run_origin_mailbox_sync(&origin, sync_metrics.clone()));
            tasks.push(self.run_interchain_gas_paymaster_sync(&origin, sync_metrics.clone()));
        }

        // each message process attempts to send messages from a chain
        for origin in &self.origin_chains {
            let metrics = MessageProcessorMetrics::new(
                &self.core.metrics,
                origin,
                self.destination_chains.iter(),
            );
            let message_processor = MessageProcessor::new(
                self.mailboxes[origin].db().clone(),
                self.whitelist.clone(),
                self.blacklist.clone(),
                metrics,
                provers_sync[origin].clone(),
                send_channels.clone(),
            );

            tasks.push(self.run_message_processor(message_processor));
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
        message_processor: MessageProcessor,
    ) -> Instrumented<JoinHandle<Result<()>>> {
        let process_fut = message_processor.spawn();
        tokio::spawn(async move {
            let res = tokio::try_join!(process_fut)?;
            info!(?res, "try_join finished for message processor");
            Ok(())
        })
        .instrument(info_span!("run message processor"))
    }

    #[allow(clippy::too_many_arguments)]
    #[tracing::instrument(fields(destination=%destination_mailbox.domain()))]
    fn run_destination_mailbox(
        &self,
        destination_mailbox: CachingMailbox,
        // by origin
        metadata_builders: HashMap<HyperlaneDomain, BaseMetadataBuilder>,
        msg_receive: UnboundedReceiver<PendingMessage>,
    ) -> Instrumented<JoinHandle<Result<()>>> {
        let origin_mailbox = self.mailboxes.get(&self.origin_chain).unwrap();
        let destination = destination_mailbox.domain();

        let transaction_gas_limit = if self
            .skip_transaction_gas_limit_for
            .contains(&destination.id())
        {
            None
        } else {
            self.transaction_gas_limit
        };
        // TODO: Create a new layer to split this up such that there is a
        //  MessageSubmitter which then sends to a SerialTxnSubmitter that just blindly
        //  tries to send transactions. A good approach for this might be to create a Trait for
        //  "ProducesTxn" which can then be called by the SerialTxnSubmitter. This would allow
        //  for txns from other sources down the road.
        //  Alternatively extend the SerialSubmitter to accept transactions from different domains.
        let serial_submitter = SerialSubmitter::new(
            msg_receive,
            destination_mailbox.clone(),
            metadata_builder,
            origin_mailbox.db().clone(),
            SerialSubmitterMetrics::new(&self.core.metrics, &self.origin_chain, destination),
            gas_payment_enforcer,
            transaction_gas_limit,
        );

        let submit_fut = serial_submitter.spawn();

        tokio::spawn(async move {
            let res = tokio::try_join!(submit_fut)?;
            info!(?res, "try_join finished for mailbox");
            Ok(())
        })
        .instrument(info_span!("run mailbox"))
    }
}

#[cfg(test)]
mod test {}
