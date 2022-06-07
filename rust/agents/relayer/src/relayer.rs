use async_trait::async_trait;
use eyre::{Context, Result};
use tokio::{sync::mpsc::channel, task::JoinHandle};
use tracing::{instrument::Instrumented, Instrument};

use abacus_base::{
    AbacusAgentCore, Agent, ContractSyncMetrics, InboxContracts, MultisigCheckpointSyncer,
};
use abacus_core::MultisigSignedCheckpoint;

use crate::settings::CompiledWhitelist;
use crate::{
    checkpoint_relayer::CheckpointRelayer, message_processor::MessageProcessor,
    settings::RelayerSettings as Settings,
};

/// The buffer size of the channel in which signed checkpoints are sent over.
const SIGNED_CHECKPOINT_CHANNEL_BUFFER: usize = 1000;

/// A relayer agent
#[derive(Debug)]
pub struct Relayer {
    polling_interval: u64,
    max_retries: u32,
    submission_latency: u64,
    relayer_message_processing: bool,
    multisig_checkpoint_syncer: MultisigCheckpointSyncer,
    core: AbacusAgentCore,
    whitelist: Option<CompiledWhitelist>,
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

    type Settings = Settings;

    async fn from_settings(settings: Self::Settings) -> Result<Self>
    where
        Self: Sized,
    {
        let multisig_checkpoint_syncer: MultisigCheckpointSyncer = settings
            .multisigcheckpointsyncer
            .try_into_multisig_checkpoint_syncer()?;
        Ok(Self {
            polling_interval: settings.pollinginterval.parse().unwrap_or(5),
            max_retries: settings.maxretries.parse().unwrap_or(10),
            submission_latency: settings.submissionlatency.parse().expect("invalid uint"),
            relayer_message_processing: settings.relayermessageprocessing.parse().unwrap_or(false),
            multisig_checkpoint_syncer,
            core: settings
                .as_ref()
                .try_into_abacus_core(Self::AGENT_NAME)
                .await?,
            whitelist: settings
                .whitelist
                .map(|wl| wl.try_into().expect("Invalid whitelist configuration")),
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
        sync_metrics: ContractSyncMetrics,
    ) -> Instrumented<JoinHandle<Result<()>>> {
        let paymaster = self.interchain_gas_paymaster();
        let sync = paymaster.sync(self.as_ref().indexer.clone(), sync_metrics);
        sync
    }

    fn run_inbox(&self, inbox_contracts: InboxContracts) -> Instrumented<JoinHandle<Result<()>>> {
        let db = self.outbox().db();
        let (signed_checkpoint_sender, signed_checkpoint_receiver) =
            channel::<MultisigSignedCheckpoint>(SIGNED_CHECKPOINT_CHANNEL_BUFFER);

        let checkpoint_relayer = CheckpointRelayer::new(
            self.outbox().outbox(),
            self.polling_interval,
            self.submission_latency,
            self.relayer_message_processing,
            db.clone(),
            inbox_contracts.clone(),
            self.multisig_checkpoint_syncer.clone(),
            signed_checkpoint_sender,
            self.core.metrics.last_known_message_leaf_index(),
        );
        let message_processor = MessageProcessor::new(
            self.outbox().outbox(),
            self.polling_interval,
            self.max_retries,
            db,
            self.submission_latency,
            inbox_contracts,
            signed_checkpoint_receiver,
            self.core.metrics.last_known_message_leaf_index(),
            self.core.metrics.retry_queue_length(),
        );

        self.run_all(vec![checkpoint_relayer.spawn(), message_processor.spawn()])
    }

    fn wrap_inbox_run(
        &self,
        inbox_name: &str,
        inbox_contracts: InboxContracts,
    ) -> Instrumented<JoinHandle<Result<()>>> {
        let m = format!("Task for inbox named {} failed", inbox_name);
        let handle = self.run_inbox(inbox_contracts).in_current_span();
        let fut = async move { handle.await?.wrap_err(m) };

        tokio::spawn(fut).in_current_span()
    }

    pub fn run(&self) -> Instrumented<JoinHandle<Result<()>>> {
        let mut tasks: Vec<Instrumented<JoinHandle<Result<()>>>> = self
            .inboxes()
            .iter()
            .map(|(inbox_name, inbox_contracts)| {
                self.wrap_inbox_run(inbox_name, inbox_contracts.clone())
            })
            .collect();
        let sync_metrics = ContractSyncMetrics::new(self.metrics());
        tasks.push(self.run_outbox_sync(sync_metrics.clone()));
        tasks.push(self.run_interchain_gas_paymaster_sync(sync_metrics));
        self.run_all(tasks)
    }
}

#[cfg(test)]
mod test {}
