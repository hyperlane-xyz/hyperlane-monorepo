use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use async_trait::async_trait;
use eyre::Result;
use hyperlane_base::db::HyperlaneRocksDB;
use hyperlane_base::{ContractSync, ContractSyncMetrics};
use tokio::sync::{
    mpsc::{self, UnboundedReceiver, UnboundedSender},
    RwLock,
};
use tokio::task::JoinHandle;
use tracing::{info, info_span, instrument::Instrumented, Instrument};

use hyperlane_base::{db::DB, run_all, BaseAgent, CoreMetrics, HyperlaneAgentCore};
use hyperlane_core::{
    HyperlaneChain, HyperlaneDB, HyperlaneDomain, HyperlaneMessage, HyperlaneMessageDB, Indexer,
    InterchainGasPayment, Mailbox, MessageIndexer, ValidatorAnnounce, U256,
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
    origin_mailbox_sync:
        Arc<ContractSync<HyperlaneMessage, Arc<dyn HyperlaneMessageDB>, Arc<dyn MessageIndexer>>>,
    origin_interchain_gas_paymaster_sync: Arc<
        ContractSync<
            InterchainGasPayment,
            Arc<dyn HyperlaneDB<InterchainGasPayment>>,
            Arc<dyn Indexer<InterchainGasPayment>>,
        >,
    >,
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
        let contract_sync_metrics = Arc::new(ContractSyncMetrics::new(&metrics));

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

        let origin_mailbox_sync = settings
            .build_message_sync(
                &settings.origin_chain,
                &metrics,
                &contract_sync_metrics,
                origin_db.clone(),
            )
            .await?
            .into();
        let origin_interchain_gas_paymaster_sync = settings
            .build_interchain_gas_payment_sync(
                &settings.origin_chain,
                &metrics,
                &contract_sync_metrics,
                origin_db.clone(),
            )
            .await?
            .into();
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
            origin_mailbox_sync,
            origin_interchain_gas_paymaster_sync,
            origin_validator_announce: origin_validator_announce.into(),
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
        // One task for the message processor
        // One task for each destination chain mailbox
        // One task to sync the origin chain mailbox
        // One task to sync the origin chain IGP
        let destinations = self
            .destination_mailboxes
            .keys()
            .collect::<Vec<&HyperlaneDomain>>();
        let num_tasks = destinations.len() + 3;
        let mut tasks = Vec::with_capacity(num_tasks);
        tasks.push(self.run_origin_mailbox_sync().await);
        tasks.push(self.run_interchain_gas_paymaster_sync().await);

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
    async fn run_origin_mailbox_sync(&self) -> Instrumented<JoinHandle<eyre::Result<()>>> {
        let index_settings = self.as_ref().settings.chains[self.origin_chain.name()]
            .index
            .clone();
        let cursor = self
            .origin_mailbox_sync
            .forward_message_sync_cursor(index_settings)
            .await;
        let sync = self.origin_mailbox_sync.clone();
        tokio::spawn(async move { sync.sync("dispatched_messages", cursor).await })
            .instrument(info_span!("ContractSync"))
    }

    async fn run_interchain_gas_paymaster_sync(
        &self,
    ) -> Instrumented<JoinHandle<eyre::Result<()>>> {
        // TODO: We can modify the index settings here to pull the latest synced block number from the
        // rocks DB.
        // But how do we update it? I guess we need a function on HyperlaneDB to do that as well?
        // Similarly we need to do the same for the latest block number for deliveries...
        let index_settings = self.as_ref().settings.chains[self.origin_chain.name()]
            .index
            .clone();
        let cursor = self
            .origin_interchain_gas_paymaster_sync
            .rate_limited_cursor(index_settings)
            .await;
        let sync = self.origin_interchain_gas_paymaster_sync.clone();
        tokio::spawn(async move { sync.sync("gas_payments", cursor).await })
            .instrument(info_span!("ContractSync"))
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
