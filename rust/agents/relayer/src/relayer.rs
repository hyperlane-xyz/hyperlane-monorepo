use async_trait::async_trait;
use color_eyre::{eyre::Context, Result};
use std::sync::Arc;
use tokio::task::JoinHandle;
use tracing::{instrument::Instrumented, Instrument};

use abacus_base::{AbacusAgentCore, Agent, CachingInbox};

use crate::{checkpoint_relayer::CheckpointRelayer, settings::RelayerSettings as Settings};

/// A relayer agent
#[derive(Debug)]
pub struct Relayer {
    interval: u64,
    core: AbacusAgentCore,
    updates_relayed_count: Arc<prometheus::IntCounterVec>,
}

impl AsRef<AbacusAgentCore> for Relayer {
    fn as_ref(&self) -> &AbacusAgentCore {
        &self.core
    }
}

#[allow(clippy::unit_arg)]
impl Relayer {
    /// Instantiate a new relayer
    pub fn new(interval: u64, core: AbacusAgentCore) -> Self {
        let updates_relayed_count = Arc::new(
            core.metrics
                .new_int_counter(
                    "updates_relayed_count",
                    "Number of updates relayed from given home to replica",
                    &["home", "replica", "agent"],
                )
                .expect("processor metric already registered -- should have be a singleton"),
        );

        Self {
            interval,
            core,
            updates_relayed_count,
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
        Ok(Self::new(
            settings.interval.parse().expect("invalid uint"),
            settings
                .as_ref()
                .try_into_abacus_core(Self::AGENT_NAME)
                .await?,
        ))
    }
}

impl Relayer {
    fn run_inbox(&self, inbox: Arc<CachingInbox>) -> Instrumented<JoinHandle<Result<()>>> {
        let submit = CheckpointRelayer::new(self.interval, inbox);
        self.run_all(vec![submit.spawn()])
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
        let inbox_tasks = self
            .inboxes()
            .iter()
            .map(|(inbox_name, inbox)| self.wrap_inbox_run(inbox_name, inbox.clone()))
            .collect();
        self.run_all(inbox_tasks)
    }
}

#[cfg(test)]
mod test {}
