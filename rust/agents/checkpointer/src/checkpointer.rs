use async_trait::async_trait;
use color_eyre::Result;
use tokio::task::JoinHandle;
use tracing::instrument::Instrumented;

use crate::{settings::CheckpointerSettings as Settings, submit::CheckpointSubmitter};
use abacus_base::{AbacusAgentCore, Agent};

/// An checkpointer agent
#[derive(Debug)]
pub struct Checkpointer {
    /// Polling interval
    interval: u64,
    // Minimum seconds between submitted checkpoints
    latency: u64,
    pub(crate) core: AbacusAgentCore,
}

impl AsRef<AbacusAgentCore> for Checkpointer {
    fn as_ref(&self) -> &AbacusAgentCore {
        &self.core
    }
}

impl Checkpointer {
    /// Instantiate a new checkpointer
    pub fn new(interval: u64, latency: u64, core: AbacusAgentCore) -> Self {
        Self {
            interval,
            latency,
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
        let interval = settings.interval.parse().expect("invalid interval uint");
        let latency = settings.latency.parse().expect("invalid latency uint");
        let core = settings
            .as_ref()
            .try_into_abacus_core(Self::AGENT_NAME)
            .await?;
        Ok(Self::new(interval, latency, core))
    }
}

impl Checkpointer {
    pub fn run(&self) -> Instrumented<JoinHandle<Result<()>>> {
        let outbox = self.outbox();

        let submit = CheckpointSubmitter::new(outbox, self.interval, self.latency);

        self.run_all(vec![submit.spawn()])
    }
}

#[cfg(test)]
mod test {}
