use async_trait::async_trait;
use color_eyre::{eyre::Context, Result};
use std::sync::Arc;
use tokio::task::JoinHandle;
use tracing::{instrument::Instrumented, Instrument};

use abacus_base::{AbacusAgentCore, Agent, CachingInbox, CheckpointSyncers, ContractSyncMetrics};

use crate::{
    checkpoint_relayer::CheckpointRelayer, message_processor::MessageProcessor,
    settings::RelayerSettings as Settings,
};

/// A relayer agent
#[derive(Debug)]
pub struct Relayer {
    polling_interval: u64,
    max_retries: u32,
    submission_latency: u64,
    relayer_message_processing: bool,
    checkpoint_syncer: CheckpointSyncers,
    core: AbacusAgentCore,
    checkpoints_relayed_count: Arc<prometheus::IntCounterVec>,
}

impl AsRef<AbacusAgentCore> for Relayer {
    fn as_ref(&self) -> &AbacusAgentCore {
        &self.core
    }
}

#[allow(clippy::unit_arg)]
impl Relayer {
    /// Instantiate a new relayer
    pub fn new(
        polling_interval: u64,
        max_retries: u32,
        submission_latency: u64,
        relayer_message_processing: bool,
        checkpoint_syncer: CheckpointSyncers,
        core: AbacusAgentCore,
    ) -> Self {
        let checkpoints_relayed_count = Arc::new(
            core.metrics
                .new_int_counter(
                    "checkpoints_relayed_count",
                    "Number of checkpoints relayed from given outbox to inbox",
                    &["outbox", "inbox", "agent"],
                )
                .expect("processor metric already registered -- should be a singleton"),
        );

        Self {
            polling_interval,
            max_retries,
            submission_latency,
            relayer_message_processing,
            checkpoint_syncer,
            core,
            checkpoints_relayed_count,
        }
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
        let checkpoint_syncer = settings
            .checkpointsyncer
            .try_into_checkpoint_syncer()
            .await?;
        Ok(Self::new(
            settings.pollinginterval.parse().unwrap_or(5),
            settings.maxretries.parse().unwrap_or(10),
            settings.submissionlatency.parse().expect("invalid uint"),
            settings.relayermessageprocessing.parse().unwrap_or(false),
            checkpoint_syncer,
            settings
                .as_ref()
                .try_into_abacus_core(Self::AGENT_NAME)
                .await?,
        ))
    }
}

impl Relayer {
    fn run_contract_sync(&self) -> Instrumented<JoinHandle<Result<()>>> {
        let sync_metrics = ContractSyncMetrics::new(self.metrics(), None);
        let sync = self.outbox().sync(
            Self::AGENT_NAME.to_string(),
            self.as_ref().indexer.clone(),
            sync_metrics,
        );
        sync
    }

    fn run_inbox(&self, inbox: Arc<CachingInbox>) -> Instrumented<JoinHandle<Result<()>>> {
        let db = self.outbox().db();
        let checkpoint_relayer = CheckpointRelayer::new(
            self.polling_interval,
            self.submission_latency,
            self.relayer_message_processing,
            db.clone(),
            inbox.clone(),
            self.checkpoint_syncer.clone(),
        );
        let message_processor = MessageProcessor::new(
            self.polling_interval,
            self.max_retries,
            db,
            self.submission_latency,
            inbox,
        );

        self.run_all(vec![checkpoint_relayer.spawn(), message_processor.spawn()])
    }

    fn wrap_inbox_run(
        &self,
        inbox_name: &str,
        inbox: Arc<CachingInbox>,
    ) -> Instrumented<JoinHandle<Result<()>>> {
        let m = format!("Task for inbox named {} failed", inbox_name);
        let handle = self.run_inbox(inbox).in_current_span();
        let fut = async move { handle.await?.wrap_err(m) };

        tokio::spawn(fut).in_current_span()
    }

    pub fn run(&self) -> Instrumented<JoinHandle<Result<()>>> {
        let mut inbox_tasks: Vec<Instrumented<JoinHandle<Result<()>>>> = self
            .inboxes()
            .iter()
            .map(|(inbox_name, inbox)| self.wrap_inbox_run(inbox_name, inbox.clone()))
            .collect();
        inbox_tasks.push(self.run_contract_sync());
        self.run_all(inbox_tasks)
    }
}

#[cfg(test)]
mod test {}
