use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use async_trait::async_trait;
use eyre::Result;
use hyperlane_base::db::HyperlaneRocksDB;
use hyperlane_base::SyncType;
use tokio::sync::{
    mpsc::{self, UnboundedReceiver, UnboundedSender},
    RwLock,
};
use tokio::task::JoinHandle;
use tracing::{info, info_span, instrument::Instrumented, Instrument};

use hyperlane_base::{
    db::DB, run_all, BaseAgent, CachingInterchainGasPaymaster, CachingMailbox, ContractSyncMetrics,
    CoreMetrics, HyperlaneAgentCore,
};
use hyperlane_core::{
    ChainResult, HyperlaneChain, HyperlaneDomain, InterchainGasPaymaster, Mailbox,
    ValidatorAnnounce, U256,
};

use crate::{
    merkle_tree_builder::MerkleTreeBuilder,
    msg::{
        gas_payment::GasPaymentEnforcer,
        metadata::BaseMetadataBuilder,
        processor::{MessageProcessor, MessageProcessorMetrics},
        serial_submitter::{SerialSubmitter, SerialSubmitterMetrics},
        PendingMessage,
    },
    settings::{matching_list::MatchingList, RelayerSettings},
};

/// A relayer agent
#[derive(Debug)]
pub struct Relayer {
    origin_chain: HyperlaneDomain,
    core: HyperlaneAgentCore,
    origin_mailbox: CachingMailbox,
    origin_interchain_gas_paymaster: CachingInterchainGasPaymaster,
    origin_validator_announce: Arc<dyn ValidatorAnnounce>,
    destination_mailboxes: HashMap<HyperlaneDomain, Arc<dyn Mailbox>>,
    gas_payment_enforcer: Arc<GasPaymentEnforcer>,
    whitelist: Arc<MatchingList>,
    blacklist: Arc<MatchingList>,
    transaction_gas_limit: Option<U256>,
    skip_transaction_gas_limit_for: HashSet<u32>,
    allow_local_checkpoint_syncers: bool,
    origin_db: Arc<HyperlaneRocksDB>,
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
        let origin_db = Arc::new(HyperlaneRocksDB::new(&settings.origin_chain, db.clone()));

        // Use defined remote chains + the origin chain
        let domains = settings
            .destination_chains
            .iter()
            .chain([&settings.origin_chain])
            .collect::<Vec<_>>();
        let destinations = domains
            .into_iter()
            .filter(|c| **c != settings.origin_chain)
            .collect::<Vec<&HyperlaneDomain>>();

        // TODO: Really each of these should take a different DB...
        let origin_mailbox = settings
            .build_caching_mailbox(&settings.origin_chain, &metrics, origin_db.clone())
            .await?;
        let origin_interchain_gas_paymaster = settings
            .build_caching_interchain_gas_paymaster(
                &settings.origin_chain,
                &metrics,
                origin_db.clone(),
            )
            .await?;
        let origin_validator_announce = settings
            .build_validator_announce(&settings.origin_chain, &metrics)
            .await?;
        let destination_mailboxes = settings.build_mailboxes(&destinations, &metrics).await?;

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
        let gas_payment_enforcer = Arc::new(GasPaymentEnforcer::new(
            settings.gas_payment_enforcement,
            origin_db.clone(),
        ));

        Ok(Self {
            origin_chain: settings.origin_chain,
            core,
            origin_mailbox,
            origin_interchain_gas_paymaster,
            origin_validator_announce,
            destination_mailboxes,
            gas_payment_enforcer,
            whitelist,
            blacklist,
            transaction_gas_limit,
            skip_transaction_gas_limit_for,
            allow_local_checkpoint_syncers: settings.allow_local_checkpoint_syncers,
            origin_db,
        })
    }

    #[allow(clippy::async_yields_async)]
    async fn run(&self) -> Instrumented<JoinHandle<Result<()>>> {
        let sync_metrics = ContractSyncMetrics::new(self.core.metrics.clone());
        let mailbox_sync_tasks = self
            .run_origin_mailbox_sync(sync_metrics.clone())
            .await
            .unwrap();
        let igp_sync_tasks = self
            .run_interchain_gas_paymaster_sync(sync_metrics)
            .await
            .unwrap();
        // One task for the message processor
        // One task for each destination chain mailbox
        // One or two tasks to sync the origin chain mailbox
        // One or two tasks to sync the origin chain IGP
        let destinations = self
            .destination_mailboxes
            .keys()
            .collect::<Vec<&HyperlaneDomain>>();
        let num_tasks = destinations.len() + mailbox_sync_tasks.len() + igp_sync_tasks.len() + 1;
        let mut tasks = Vec::with_capacity(num_tasks);
        for task in mailbox_sync_tasks {
            tasks.push(task);
        }
        for task in igp_sync_tasks {
            tasks.push(task);
        }

        let prover_sync = Arc::new(RwLock::new(MerkleTreeBuilder::new(self.origin_db.clone())));
        let mut send_channels: HashMap<u32, UnboundedSender<PendingMessage>> = HashMap::new();

        for chain in &destinations {
            let (send_channel, receive_channel): (
                UnboundedSender<PendingMessage>,
                UnboundedReceiver<PendingMessage>,
            ) = mpsc::unbounded_channel();
            let mailbox = self.destination_mailboxes.get(chain).unwrap();
            send_channels.insert(mailbox.domain().id(), send_channel);

            let chain_setup = self
                .core
                .settings
                .chain_setup(chain)
                .unwrap_or_else(|_| panic!("No chain setup found for {}", chain.name()))
                .clone();

            let metadata_builder = BaseMetadataBuilder::new(
                chain_setup,
                prover_sync.clone(),
                self.origin_validator_announce.clone(),
                self.allow_local_checkpoint_syncers,
                self.core.metrics.clone(),
                0,
                5,
            );
            tasks.push(self.run_destination_mailbox(
                mailbox.clone(),
                metadata_builder.clone(),
                self.gas_payment_enforcer.clone(),
                receive_channel,
            ));
        }

        let metrics =
            MessageProcessorMetrics::new(&self.core.metrics, &self.origin_chain, destinations);
        let message_processor = MessageProcessor::new(
            self.origin_db.clone(),
            self.whitelist.clone(),
            self.blacklist.clone(),
            metrics,
            prover_sync,
            send_channels,
        );
        tasks.push(self.run_message_processor(message_processor));

        run_all(tasks)
    }
}

impl Relayer {
    async fn run_origin_mailbox_sync(
        &self,
        sync_metrics: ContractSyncMetrics,
    ) -> eyre::Result<Vec<Instrumented<JoinHandle<eyre::Result<()>>>>> {
        let index_settings = self.as_ref().settings.chains[self.origin_chain.name()]
            .index
            .clone();
        self.origin_mailbox
            .sync_dispatched_messages(index_settings, SyncType::MiddleOut, sync_metrics)
            .await
    }

    async fn run_interchain_gas_paymaster_sync(
        &self,
        sync_metrics: ContractSyncMetrics,
    ) -> eyre::Result<Vec<Instrumented<JoinHandle<eyre::Result<()>>>>> {
        self.origin_interchain_gas_paymaster
            .sync_gas_payments(
                self.as_ref().settings.chains[self.origin_chain.name()]
                    .index
                    .clone(),
                SyncType::Forward,
                sync_metrics,
            )
            .await
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
        destination_mailbox: Arc<dyn Mailbox>,
        metadata_builder: BaseMetadataBuilder,
        gas_payment_enforcer: Arc<GasPaymentEnforcer>,
        msg_receive: UnboundedReceiver<PendingMessage>,
    ) -> Instrumented<JoinHandle<Result<()>>> {
        let destination = destination_mailbox.domain();

        let transaction_gas_limit = if self
            .skip_transaction_gas_limit_for
            .contains(&destination.id())
        {
            None
        } else {
            self.transaction_gas_limit
        };
        let serial_submitter = SerialSubmitter::new(
            msg_receive,
            destination_mailbox.clone(),
            metadata_builder,
            self.origin_db.clone(),
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
