use async_trait::async_trait;
use color_eyre::Result;
use futures_util::future::select_all;
use tokio::task::JoinHandle;
use tracing::{instrument::Instrumented, Instrument};

use crate::{settings::CheckpointerSettings as Settings, submit::CheckpointSubmitter};
use abacus_base::{AbacusAgent, AgentCore};
use abacus_core::{db::AbacusDB, Common};

/// An checkpointer agent
#[derive(Debug)]
pub struct Checkpointer {
    interval_seconds: u64,
    pub(crate) core: AgentCore,
}

impl AsRef<AgentCore> for Checkpointer {
    fn as_ref(&self) -> &AgentCore {
        &self.core
    }
}

impl Checkpointer {
    /// Instantiate a new checkpointer
    pub fn new(interval_seconds: u64, core: AgentCore) -> Self {
        Self {
            interval_seconds,
            core,
        }
    }
}

#[async_trait]
impl AbacusAgent for Checkpointer {
    const AGENT_NAME: &'static str = "checkpointer";

    type Settings = Settings;

    async fn from_settings(settings: Self::Settings) -> Result<Self>
    where
        Self: Sized,
    {
        let interval_seconds = settings.interval.parse().expect("invalid uint");
        let core = settings.as_ref().try_into_core(Self::AGENT_NAME).await?;
        Ok(Self::new(interval_seconds, core))
    }

    fn run(&self, _replica: &str) -> Instrumented<JoinHandle<Result<()>>> {
        let home = self.home();
        let db = AbacusDB::new(self.home().name(), self.db());

        let submit = CheckpointSubmitter::new(home, db, self.interval_seconds);

        tokio::spawn(async move {
            let submit_task = submit.spawn();

            let (res, _, rem) = select_all(vec![submit_task]).await;

            for task in rem.into_iter() {
                task.into_inner().abort();
            }
            res?
        })
        .in_current_span()
    }
}

#[cfg(test)]
mod test {}
