use std::sync::Arc;

use async_trait::async_trait;
use eyre::Result;
use tokio::task::JoinHandle;
use tracing::instrument::Instrumented;

use abacus_base::{run_all, AbacusAgentCore, Agent, BaseAgent, CheckpointSyncers, CoreMetrics};
use abacus_core::{AbacusContract, Signers};

use crate::submit::ValidatorSubmitterMetrics;
use crate::{settings::ValidatorSettings, submit::ValidatorSubmitter};

/// A validator agent
#[derive(Debug)]
pub struct Validator {
    origin_chain_name: String,
    signer: Arc<Signers>,
    reorg_period: u64,
    interval: u64,
    checkpoint_syncer: Arc<CheckpointSyncers>,
    pub(crate) core: AbacusAgentCore,
}

impl Validator {
    /// Instantiate a new validator
    pub fn new(
        origin_chain_name: String,
        signer: Signers,
        reorg_period: u64,
        interval: u64,
        checkpoint_syncer: CheckpointSyncers,
        core: AbacusAgentCore,
    ) -> Self {
        Self {
            origin_chain_name,
            signer: Arc::new(signer),
            reorg_period,
            interval,
            checkpoint_syncer: Arc::new(checkpoint_syncer),
            core,
        }
    }
}

impl AsRef<AbacusAgentCore> for Validator {
    fn as_ref(&self) -> &AbacusAgentCore {
        &self.core
    }
}

#[async_trait]
impl BaseAgent for Validator {
    const AGENT_NAME: &'static str = "validator";

    type Settings = ValidatorSettings;

    async fn from_settings(settings: Self::Settings, metrics: Arc<CoreMetrics>) -> Result<Self>
    where
        Self: Sized,
    {
        let signer = settings.validator.try_into_signer().await?;
        let reorg_period = settings.reorgperiod.parse().expect("invalid uint");
        let origin_chain_name = &settings.originchainname;
        let interval = settings.interval.parse().expect("invalid uint");
        let core = settings
            .as_ref()
            .try_into_abacus_core(metrics,Some([origin_chain_name].into_iter().collect()))
            .await?;
        let checkpoint_syncer = settings.checkpointsyncer.try_into_checkpoint_syncer(None)?;

        Ok(Self::new(
            origin_chain_name.clone(),
            signer,
            reorg_period,
            interval,
            checkpoint_syncer,
            core,
        ))
    }

    #[allow(clippy::async_yields_async)]
    async fn run(&self) -> Instrumented<JoinHandle<Result<()>>> {
        let submit = ValidatorSubmitter::new(
            self.interval,
            self.reorg_period,
            self.mailbox(self.origin_chain_name.clone()).clone(),
            self.signer.clone(),
            self.checkpoint_syncer.clone(),
            ValidatorSubmitterMetrics::new(&self.core.metrics, &self.origin_chain_name),
        );

        run_all(vec![submit.spawn()])
    }
}

#[cfg(test)]
mod test {}
