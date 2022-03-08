use async_trait::async_trait;
use color_eyre::Result;
use tokio::task::JoinHandle;
use tracing::instrument::Instrumented;

use crate::{settings::ValidatorSettings as Settings, submit::ValidatorSubmitter};
use abacus_base::{AbacusAgentCore, Agent};
use abacus_core::{db::AbacusDB, AbacusCommon};

/// An validator agent
#[derive(Debug)]
pub struct Validator {
    reorg_period: u64,
    pub(crate) core: AbacusAgentCore,
}

impl AsRef<AbacusAgentCore> for Validator {
    fn as_ref(&self) -> &AbacusAgentCore {
        &self.core
    }
}

impl Validator {
    /// Instantiate a new validator
    pub fn new(reorg_period: u64, core: AbacusAgentCore) -> Self {
        Self { reorg_period, core }
    }
}

#[async_trait]
impl Agent for Validator {
    const AGENT_NAME: &'static str = "validator";

    type Settings = Settings;

    async fn from_settings(settings: Self::Settings) -> Result<Self>
    where
        Self: Sized,
    {
        let reorg_period = settings.reorg_period.parse().expect("invalid uint");
        let core = settings
            .as_ref()
            .try_into_abacus_core(Self::AGENT_NAME)
            .await?;
        Ok(Self::new(reorg_period, core))
    }
}

impl Validator {
    pub fn run(&self) -> Instrumented<JoinHandle<Result<()>>> {
        let outbox = self.outbox();
        let db = AbacusDB::new(self.outbox().name(), self.db());

        let submit = ValidatorSubmitter::new(outbox, db, self.reorg_period);

        self.run_all(vec![submit.spawn()])
    }
}

#[cfg(test)]
mod test {}
