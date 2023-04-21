use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use async_trait::async_trait;
use eyre::Result;
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
use hyperlane_core::{HyperlaneChain, HyperlaneDomain, ValidatorAnnounce, U256};

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
    mailboxes: HashMap<HyperlaneDomain, CachingMailbox>,
    validator_announce: Arc<dyn ValidatorAnnounce>,
    interchain_gas_paymasters: HashMap<HyperlaneDomain, CachingInterchainGasPaymaster>,
    gas_payment_enforcer: Arc<GasPaymentEnforcer>,
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

        // Use defined remote chains + the origin chain
        let domains = settings
            .destination_chains
            .iter()
            .chain([&settings.origin_chain])
            .collect::<Vec<_>>();

        let mailboxes = settings
            .build_all_mailboxes(&domains, &metrics, db.clone())
            .await?;
        let interchain_gas_paymasters = settings
            .build_all_interchain_gas_paymasters(&domains, &metrics, db)
            .await?;
        let validator_announce = settings
            .build_validator_announce(&settings.origin_chain, &core.metrics.clone())
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
        let gas_payment_enforcer = Arc::new(GasPaymentEnforcer::new(
            settings.gas_payment_enforcement,
            mailboxes.get(&settings.origin_chain).unwrap().db().clone(),
        ));

        Ok(Self {
            origin_chain: settings.origin_chain,
            core,
            mailboxes,
            validator_announce,
            interchain_gas_paymasters,
            gas_payment_enforcer,
            whitelist,
            blacklist,
            transaction_gas_limit,
            skip_transaction_gas_limit_for,
            allow_local_checkpoint_syncers: settings.allow_local_checkpoint_syncers,
        })
    }

    #[allow(clippy::async_yields_async)]
    async fn run(&self) -> Instrumented<JoinHandle<Result<()>>> {
        let num_mailboxes = self.mailboxes.len();

        let mut tasks = Vec::with_capacity(num_mailboxes + 2);

        let prover_sync = Arc::new(RwLock::new(MerkleTreeBuilder::new(
            self.mailboxes.get(&self.origin_chain).unwrap().db().clone(),
        )));
        let mut send_channels: HashMap<u32, UnboundedSender<PendingMessage>> = HashMap::new();
        let destinations = self
            .mailboxes
            .keys()
            .filter(|c| **c != self.origin_chain)
            .collect::<Vec<&HyperlaneDomain>>();

        for chain in &destinations {
            let (send_channel, receive_channel): (
                UnboundedSender<PendingMessage>,
                UnboundedReceiver<PendingMessage>,
            ) = mpsc::unbounded_channel();
            let mailbox: &CachingMailbox = self.mailboxes.get(chain).unwrap();
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
                self.validator_announce.clone(),
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

        let sync_metrics = ContractSyncMetrics::new(self.core.metrics.clone());
        tasks.push(self.run_origin_mailbox_sync(sync_metrics.clone()));

        let metrics =
            MessageProcessorMetrics::new(&self.core.metrics, &self.origin_chain, destinations);
        let message_processor = MessageProcessor::new(
            self.mailboxes.get(&self.origin_chain).unwrap().db().clone(),
            self.whitelist.clone(),
            self.blacklist.clone(),
            metrics,
            prover_sync,
            send_channels,
        );
        tasks.push(self.run_message_processor(message_processor));

        tasks.push(self.run_interchain_gas_paymaster_sync(sync_metrics));

        run_all(tasks)
    }
}

impl Relayer {
    fn run_origin_mailbox_sync(
        &self,
        sync_metrics: ContractSyncMetrics,
    ) -> Instrumented<JoinHandle<Result<()>>> {
        let mailbox = self.mailboxes.get(&self.origin_chain).unwrap();
        let sync = mailbox.sync(
            self.as_ref().settings.chains[self.origin_chain.name()]
                .index
                .clone(),
            sync_metrics,
        );
        sync
    }

    fn run_interchain_gas_paymaster_sync(
        &self,
        sync_metrics: ContractSyncMetrics,
    ) -> Instrumented<JoinHandle<Result<()>>> {
        let paymaster = self
            .interchain_gas_paymasters
            .get(&self.origin_chain)
            .unwrap();
        let sync = paymaster.sync(
            self.as_ref().settings.chains[self.origin_chain.name()]
                .index
                .clone(),
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
        metadata_builder: BaseMetadataBuilder,
        gas_payment_enforcer: Arc<GasPaymentEnforcer>,
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
