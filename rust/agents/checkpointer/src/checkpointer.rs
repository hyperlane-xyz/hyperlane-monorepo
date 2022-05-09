use async_trait::async_trait;
use eyre::Result;
use tokio::task::JoinHandle;
use tracing::instrument::Instrumented;

use abacus_base::{AbacusAgentCore, Agent};

use crate::{settings::CheckpointerSettings as Settings, submit::CheckpointSubmitter};

/// A checkpointer agent
#[derive(Debug)]
pub struct Checkpointer {
    /// The polling interval (in seconds)
    polling_interval: u64,
    /// The minimum period between created checkpoints (in seconds)
    creation_latency: u64,
    pub(crate) core: AbacusAgentCore,
}

impl AsRef<AbacusAgentCore> for Checkpointer {
    fn as_ref(&self) -> &AbacusAgentCore {
        &self.core
    }
}

impl Checkpointer {
    /// Instantiate a new checkpointer
    pub fn new(polling_interval: u64, creation_latency: u64, core: AbacusAgentCore) -> Self {
        Self {
            polling_interval,
            creation_latency,
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
        let polling_interval = settings
            .pollinginterval
            .parse()
            .expect("invalid pollinginterval uint");
        let creation_latency = settings
            .creationlatency
            .parse()
            .expect("invalid creationlatency uint");
        let core = settings
            .as_ref()
            .try_into_abacus_core(Self::AGENT_NAME)
            .await?;
        Ok(Self::new(polling_interval, creation_latency, core))
    }
}

impl Checkpointer {
    pub fn run(&self) -> Instrumented<JoinHandle<Result<()>>> {
        let outbox = self.outbox();

        let submit = CheckpointSubmitter::new(outbox, self.polling_interval, self.creation_latency);

        self.run_all(vec![submit.spawn()])
    }
}

#[cfg(test)]
mod test {}
