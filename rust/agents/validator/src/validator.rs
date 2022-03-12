use std::sync::Arc;

use async_trait::async_trait;
use color_eyre::Result;
use tokio::task::JoinHandle;
use tracing::instrument::Instrumented;

use crate::{settings::ValidatorSettings as Settings, submit::ValidatorSubmitter};
use abacus_base::{AbacusAgentCore, Agent};
use abacus_core::Signers;

/// An validator agent
#[derive(Debug)]
pub struct Validator {
    signer: Arc<Signers>,
    reorg_period: u64,
    interval: u64,
    pub(crate) core: AbacusAgentCore,
}

impl AsRef<AbacusAgentCore> for Validator {
    fn as_ref(&self) -> &AbacusAgentCore {
        &self.core
    }
}

impl Validator {
    /// Instantiate a new validator
    pub fn new(signer: Signers, reorg_period: u64, interval: u64, core: AbacusAgentCore) -> Self {
        Self {
            signer: Arc::new(signer),
            reorg_period,
            interval,
            core,
        }
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
        let signer = settings.validator.try_into_signer().await?;
        let reorg_period = settings.reorgperiod.parse().expect("invalid uint");
        let interval = settings.interval.parse().expect("invalid uint");
        let core = settings
            .as_ref()
            .try_into_abacus_core(Self::AGENT_NAME)
            .await?;
        Ok(Self::new(signer, reorg_period, interval, core))
    }
}

impl Validator {
    pub fn run(&self) -> Instrumented<JoinHandle<Result<()>>> {
        let outbox = self.outbox();
        let submit = ValidatorSubmitter::new(
            self.interval,
            self.reorg_period,
            outbox,
            self.signer.clone(),
        );

        self.run_all(vec![submit.spawn()])
    }
}

#[cfg(test)]
mod test {}
