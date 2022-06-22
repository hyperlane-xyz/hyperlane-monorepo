use std::sync::Arc;

use async_trait::async_trait;
use eyre::{Context, Result, WrapErr};
use futures_util::{Future, try_join};
use tokio::{
    sync::{watch::{channel, Receiver, Sender}, futures},
    task::{JoinHandle},
};
use tracing::{info, warn, instrument::Instrumented, Instrument, info_span};

use abacus_base::{
    AbacusAgentCore, Agent, CachingInterchainGasPaymaster, ContractSyncMetrics, InboxContracts,
    MultisigCheckpointSyncer, chains::GelatoConf,
};
use abacus_core::{AbacusContract, MultisigSignedCheckpoint};

use crate::checkpoint_fetcher::CheckpointFetcher;
use crate::message_processor::MessageProcessorMetrics;
use crate::settings::whitelist::Whitelist;
use crate::{message_processor::MessageProcessor, settings::RelayerSettings};

#[derive(Debug)]
pub enum MessageSubmitter {
    SerialWithProvider(SerialSubmitterImpl),
    GelatoSubmitter(GelatoSubmitterImpl),
}

impl MessageSubmitter {
    fn new(gelato_cfg: Option<GelatoConf>) -> Self {
        if gelato_cfg.is_none() {
            MessageSubmitter::SerialWithProvider(SerialSubmitterImpl{})
        } else {
            MessageSubmitter::GelatoSubmitter(GelatoSubmitterImpl{})
        }
    }
    fn inner(&self) -> &dyn MessageSubmitterInner {
        match self {
            MessageSubmitter::SerialWithProvider(inner) => inner,
            MessageSubmitter::GelatoSubmitter(inner) => inner,
        }
    }
    fn send_message(&self) -> Result<()> {
        match self {
            SerialWithProvider => self.inner().send_message(),
            GelatoSubmitter => self.inner().send_message(),
        }
    }
    fn spawn(&self) -> Instrumented<JoinHandle<Result<()>>> {
        match self {
            SerialWithProvider => self.inner().spawn_worker_task(),
            GelatoSubmitter => self.inner().spawn_worker_task(),
        }
    }
}

#[async_trait]
trait MessageSubmitterInner {
    fn send_message(&self) -> Result<()>;
    fn spawn_worker_task(&self) -> Instrumented<JoinHandle<Result<()>>>;
}
#[derive(Debug)]
pub struct SerialSubmitterImpl;
impl MessageSubmitterInner for SerialSubmitterImpl {
    fn send_message(&self) -> Result<()> {
        Ok(())
    }
    fn spawn_worker_task(&self) -> Instrumented<JoinHandle<Result<()>>> {
        todo!()
    }
}
#[derive(Debug)]
pub struct GelatoSubmitterImpl;
impl MessageSubmitterInner for GelatoSubmitterImpl {
    fn send_message(&self) -> Result<()> {
        Ok(())
    }
    fn spawn_worker_task(&self) -> Instrumented<JoinHandle<Result<()>>> {
        todo!()
    }
}

/// A relayer agent
#[derive(Debug)]
pub struct Relayer {
    signed_checkpoint_polling_interval: u64,
    max_processing_retries: u32,
    multisig_checkpoint_syncer: MultisigCheckpointSyncer,
    core: AbacusAgentCore,
    whitelist: Arc<Whitelist>,
}

impl AsRef<AbacusAgentCore> for Relayer {
    fn as_ref(&self) -> &AbacusAgentCore {
        &self.core
    }
}

#[async_trait]
#[allow(clippy::unit_arg)]
impl Agent for Relayer {
    const AGENT_NAME: &'static str = "relayer";

    type Settings = RelayerSettings;

    async fn from_settings(settings: Self::Settings) -> Result<Self>
    where
        Self: Sized,
    {
        let multisig_checkpoint_syncer: MultisigCheckpointSyncer = settings
            .multisigcheckpointsyncer
            .try_into_multisig_checkpoint_syncer()?;
        let whitelist = Arc::new(
            settings
                .whitelist
                .as_ref()
                .map(|wl| serde_json::from_str(wl))
                .transpose()
                .expect("Invalid whitelist received")
                .unwrap_or_default(),
        );
        info!(whitelist = %whitelist, "Whitelist configuration");

        Ok(Self {
            signed_checkpoint_polling_interval: settings
                .signedcheckpointpollinginterval
                .parse()
                .unwrap_or(5),
            max_processing_retries: settings.maxprocessingretries.parse().unwrap_or(10),
            multisig_checkpoint_syncer,
            core: settings
                .as_ref()
                .try_into_abacus_core(Self::AGENT_NAME)
                .await?,
            whitelist,
        })
    }
}

impl Relayer {
    fn run_outbox_sync(
        &self,
        sync_metrics: ContractSyncMetrics,
    ) -> Instrumented<JoinHandle<Result<()>>> {
        let outbox = self.outbox();
        let sync = outbox.sync(self.as_ref().indexer.clone(), sync_metrics);
        sync
    }

    fn run_interchain_gas_paymaster_sync(
        &self,
        paymaster: Arc<CachingInterchainGasPaymaster>,
        sync_metrics: ContractSyncMetrics,
    ) -> Instrumented<JoinHandle<Result<()>>> {
        paymaster.sync(self.as_ref().indexer.clone(), sync_metrics)
    }

    fn run_checkpoint_fetcher(
        &self,
        signed_checkpoint_sender: Sender<Option<MultisigSignedCheckpoint>>,
    ) -> Instrumented<JoinHandle<Result<()>>> {
        let checkpoint_fetcher = CheckpointFetcher::new(
            self.outbox().outbox(),
            self.signed_checkpoint_polling_interval,
            self.multisig_checkpoint_syncer.clone(),
            signed_checkpoint_sender,
            self.core.metrics.last_known_message_leaf_index(),
        );
        checkpoint_fetcher.spawn()
    }

    fn run_inbox(
        &self,
        inbox_contracts: InboxContracts,
        signed_checkpoint_receiver: Receiver<Option<MultisigSignedCheckpoint>>,
        gelato_conf: Option<GelatoConf>,
    ) -> Instrumented<JoinHandle<Result<()>>> {
        let db = self.outbox().db();
        let outbox = self.outbox().outbox();
        let metrics = MessageProcessorMetrics::new(
            &self.core.metrics,
            outbox.chain_name(),
            inbox_contracts.inbox.chain_name(),
        );
        info!(
            name=%inbox_contracts.inbox,
            db=?db,
            outbox=?outbox,
            metrics=?metrics,
            gelato=?gelato_conf,
            "running inbox message processor and submit worker"
        );

        let submitter = MessageSubmitter::new(gelato_conf);
        let submit_fut = tokio::spawn(submitter.spawn());
        info!(
            submitter=?submitter,
            submitter_fut=?submit_fut,
            "using submitter"
        );

        let message_processor = MessageProcessor::new(
            outbox,
            self.max_processing_retries.clone(),
            db,
            inbox_contracts,
            signed_checkpoint_receiver,
            self.whitelist.clone(),
            metrics,
            submitter,
        );
        info!(
            message_processor=?message_processor,
            "using message processor"
        );
        let process_fut = tokio::spawn(message_processor.spawn());

        tokio::spawn(async move {
            let res = tokio::try_join!(submit_fut, process_fut)?;
            info!(?res, "try_join finished for inbox");
            Ok(())
        }).instrument(info_span!("run inbox"))
    }

    pub fn run(&self) -> Instrumented<JoinHandle<Result<()>>> {
        let (signed_checkpoint_sender, signed_checkpoint_receiver) =
            channel::<Option<MultisigSignedCheckpoint>>(None);

        let mut tasks: Vec<Instrumented<JoinHandle<Result<()>>>> = self
            .inboxes()
            .iter()
            .map(|(inbox_name, inbox_contracts)| {
                self.run_inbox(
                    inbox_contracts.clone(),
                    signed_checkpoint_receiver.clone(),
                    self.core.settings.inboxes[inbox_name].gelato_conf.clone(),
                )
            })
            .collect();

        tasks.push(self.run_checkpoint_fetcher(signed_checkpoint_sender));

        let sync_metrics = ContractSyncMetrics::new(self.metrics());
        tasks.push(self.run_outbox_sync(sync_metrics.clone()));

        if let Some(paymaster) = self.interchain_gas_paymaster() {
            tasks.push(self.run_interchain_gas_paymaster_sync(paymaster, sync_metrics));
        } else {
            info!("Interchain Gas Paymaster not provided, not running sync");
        }

        self.run_all(tasks)
    }
}

#[cfg(test)]
mod test {}
