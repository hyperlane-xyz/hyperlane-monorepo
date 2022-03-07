use async_trait::async_trait;
use color_eyre::Result;
use tokio::task::JoinHandle;
use tracing::instrument::Instrumented;

use crate::{settings::CheckpointerSettings as Settings, submit::CheckpointSubmitter};
use abacus_base::{AbacusAgentCore, Agent};
use abacus_core::{db::AbacusDB, AbacusCommon};

/// An checkpointer agent
#[derive(Debug)]
pub struct Checkpointer {
    interval_seconds: u64,
    pub(crate) core: AbacusAgentCore,
}

impl AsRef<AbacusAgentCore> for Checkpointer {
    fn as_ref(&self) -> &AbacusAgentCore {
        &self.core
    }
}

impl Checkpointer {
    /// Instantiate a new checkpointer
    pub fn new(interval_seconds: u64, core: AbacusAgentCore) -> Self {
        Self {
            interval_seconds,
            core,
        }
    }
}

#[async_trait]
impl Agent for Checkpointer {
    const AGENT_NAME: &'static str = "checkpointer";

    type Settings = Settings;

    async fn from_settings(settings: Self::Settings) -> Result<Self>
    where
        Self: Sized,
    {
        let interval_seconds = settings.interval.parse().expect("invalid uint");
        let core = settings
            .as_ref()
            .try_into_abacus_core(Self::AGENT_NAME)
            .await?;
        Ok(Self::new(interval_seconds, core))
    }
}

impl Checkpointer {
    pub fn run(&self) -> Instrumented<JoinHandle<Result<()>>> {
        let outbox = self.outbox();
        let db = AbacusDB::new(self.outbox().name(), self.db());

        let submit = CheckpointSubmitter::new(outbox, db, self.interval_seconds);

        self.run_all(vec![submit.spawn()])
    }
}

#[cfg(test)]
mod test {}
