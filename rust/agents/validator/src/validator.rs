use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use eyre::Result;
use tokio::task::JoinHandle;
use tracing::instrument::Instrumented;

use hyperlane_base::{run_all, BaseAgent, CheckpointSyncer, CoreMetrics, HyperlaneAgentCore};
use hyperlane_core::{HyperlaneDomain, HyperlaneSigner, Mailbox};

use crate::{
    settings::ValidatorSettings, submit::ValidatorSubmitter, submit::ValidatorSubmitterMetrics,
};

/// A validator agent
#[derive(Debug)]
pub struct Validator {
    origin_chain: HyperlaneDomain,
    core: HyperlaneAgentCore,
    mailbox: Arc<dyn Mailbox>,
    signer: Arc<dyn HyperlaneSigner>,
    interval: Duration,
    checkpoint_syncer: Arc<dyn CheckpointSyncer>,
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
        let core = settings.build_hyperlane_core(metrics.clone());
        let checkpoint_syncer = settings.checkpoint_syncer.build(None)?.into();

        let mailbox = settings
            .build_mailbox(&settings.origin_chain, &metrics)
            .await?
            .into();

        Ok(Self {
            origin_chain: settings.origin_chain,
            core,
            mailbox,
            signer,
            interval: settings.interval,
            checkpoint_syncer,
        })
    }

    #[allow(clippy::async_yields_async)]
    async fn run(&self) -> Instrumented<JoinHandle<Result<()>>> {
        let finality_blocks = self
            .core
            .settings
            .chain_setup(&self.origin_chain)
            .unwrap()
            .finality_blocks;

        let submit = ValidatorSubmitter::new(
            self.interval,
            finality_blocks as u64,
            self.mailbox.clone(),
            self.signer.clone(),
            self.checkpoint_syncer.clone(),
            ValidatorSubmitterMetrics::new(&self.core.metrics, &self.origin_chain),
        );

        run_all(vec![submit.spawn()])
    }
}

#[cfg(test)]
mod test {}
