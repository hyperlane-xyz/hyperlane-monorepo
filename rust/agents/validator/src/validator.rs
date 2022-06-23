use std::sync::Arc;

use async_trait::async_trait;
use tokio::task::JoinHandle;
use tracing::instrument::Instrumented;

use abacus_base::{AbacusAgentCore, Agent, CheckpointSyncers};
use abacus_core::{AbacusContract, Signers};
use eyre::Result;

use crate::submit::ValidatorSubmitterMetrics;
use crate::{settings::ValidatorSettings as Settings, submit::ValidatorSubmitter};

/// An validator agent
#[derive(Debug)]
pub struct Validator {
    signer: Arc<Signers>,
    reorg_period: u64,
    interval: u64,
    checkpoint_syncer: Arc<CheckpointSyncers>,
    pub(crate) core: AbacusAgentCore,
}

impl AsRef<AbacusAgentCore> for Validator {
    fn as_ref(&self) -> &AbacusAgentCore {
        &self.core
    }
}

impl Validator {
    /// Instantiate a new validator
    pub fn new(
        signer: Signers,
        reorg_period: u64,
        interval: u64,
        checkpoint_syncer: CheckpointSyncers,
        core: AbacusAgentCore,
    ) -> Self {
        Self {
            signer: Arc::new(signer),
            reorg_period,
            interval,
            checkpoint_syncer: Arc::new(checkpoint_syncer),
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
        let checkpoint_syncer = settings.checkpointsyncer.try_into_checkpoint_syncer()?;
        let core = settings
            .as_ref()
            .try_into_abacus_core(Self::AGENT_NAME, false)
            .await?;
        Ok(Self::new(
            signer,
            reorg_period,
            interval,
            checkpoint_syncer,
            core,
        ))
    }
}

impl Validator {
    pub fn run(&self) -> Instrumented<JoinHandle<Result<()>>> {
        let submit = ValidatorSubmitter::new(
            self.interval,
            self.reorg_period,
            self.outbox(),
            self.signer.clone(),
            self.checkpoint_syncer.clone(),
            ValidatorSubmitterMetrics::new(&self.core.metrics, self.outbox().chain_name()),
        );

        self.run_all(vec![submit.spawn()])
    }
}

#[cfg(test)]
mod test {}
