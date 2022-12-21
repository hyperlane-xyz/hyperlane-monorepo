use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use eyre::{Context, Result};
use tokio::task::JoinHandle;
use tracing::instrument::Instrumented;

use hyperlane_base::{
    run_all, Agent, BaseAgent, CheckpointSyncers, CoreMetrics, HyperlaneAgentCore,
};
use hyperlane_core::{HyperlaneDomain, HyperlaneSigner};

use crate::submit::ValidatorSubmitterMetrics;
use crate::{settings::ValidatorSettings, submit::ValidatorSubmitter};

/// A validator agent
#[derive(Debug)]
pub struct Validator {
    origin_chain: HyperlaneDomain,
    signer: Arc<dyn HyperlaneSigner>,
    reorg_period: u64,
    interval: Duration,
    checkpoint_syncer: Arc<CheckpointSyncers>,
    pub(crate) core: HyperlaneAgentCore,
}

impl AsRef<HyperlaneAgentCore> for Validator {
    fn as_ref(&self) -> &HyperlaneAgentCore {
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
        let signer = settings
            .validator
            // Intentionally using hyperlane_ethereum for the validator's signer
            .build::<hyperlane_ethereum::Signers>()
            .await
            .map(|validator| Arc::new(validator) as Arc<dyn HyperlaneSigner>)?;
        let reorg_period = settings.reorgperiod.parse().expect("invalid uint");
        let interval = Duration::from_secs(settings.interval.parse().expect("invalid uint"));
        let checkpoint_syncer = Arc::new(settings.checkpointsyncer.build(None)?);
        let core = settings
            .build_hyperlane_core(metrics, Some(vec![&settings.originchainname]))
            .await?;

        let origin_chain = core
            .settings
            .chain_setup(&settings.originchainname)
            .context("Validator must run on a configured chain")?
            .domain()?;

        Ok(Self {
            origin_chain,
            signer,
            reorg_period,
            interval,
            checkpoint_syncer,
            core,
        })
    }

    #[allow(clippy::async_yields_async)]
    async fn run(&self) -> Instrumented<JoinHandle<Result<()>>> {
        let submit = ValidatorSubmitter::new(
            self.interval,
            self.reorg_period,
            self.mailbox(&self.origin_chain).unwrap().clone(),
            self.signer.clone(),
            self.checkpoint_syncer.clone(),
            ValidatorSubmitterMetrics::new(&self.core.metrics, &self.origin_chain),
        );

        run_all(vec![submit.spawn()])
    }
}

#[cfg(test)]
mod test {}
