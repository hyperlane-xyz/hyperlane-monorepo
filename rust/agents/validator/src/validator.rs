use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use eyre::Result;
use tokio::task::JoinHandle;
use tracing::instrument::Instrumented;

use hyperlane_base::{run_all, BaseAgent, CheckpointSyncer, CoreMetrics, HyperlaneAgentCore, db::DB, CachingMailbox, ContractSyncMetrics};
use hyperlane_core::{HyperlaneDomain, HyperlaneSigner, Mailbox};

use crate::{
    settings::ValidatorSettings, submit::ValidatorSubmitter, submit::ValidatorSubmitterMetrics,
};

/// A validator agent
#[derive(Debug)]
pub struct Validator {
    origin_chain: HyperlaneDomain,
    core: HyperlaneAgentCore,
    mailbox: CachingMailbox,
    signer: Arc<dyn HyperlaneSigner>,
    reorg_period: u64,
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
        let db = DB::from_path(&settings.db)?;

        let signer = settings
            .validator
            // Intentionally using hyperlane_ethereum for the validator's signer
            .build::<hyperlane_ethereum::Signers>()
            .await
            .map(|validator| Arc::new(validator) as Arc<dyn HyperlaneSigner>)?;
        let core = settings.build_hyperlane_core(metrics.clone());
        let checkpoint_syncer = settings.checkpoint_syncer.build(None)?.into();

        let mailbox: CachingMailbox = settings
            .build_caching_mailbox(&settings.origin_chain, db, &metrics)
            .await?
            .into();

        Ok(Self {
            origin_chain: settings.origin_chain,
            core,
            mailbox,
            signer,
            reorg_period: settings.reorg_period,
            interval: settings.interval,
            checkpoint_syncer,
        })
    }

    #[allow(clippy::async_yields_async)]
    async fn run(&self) -> Instrumented<JoinHandle<Result<()>>> {
        let submit = ValidatorSubmitter::new(
            self.interval,
            self.reorg_period,
            self.mailbox.clone(),
            self.signer.clone(),
            self.checkpoint_syncer.clone(),
            ValidatorSubmitterMetrics::new(&self.core.metrics, &self.origin_chain),
        );

        // TODO: fetch latest branch from Mailbox storage using eth_getStorateAt
        // | Name          | Type                               | Slot | Offset | Bytes | Contract                      |
        // | tree          | struct MerkleLib.Tree              | 152  | 0      | 1056  | contracts/Mailbox.sol:Mailbox |

        // TODO: initialize copy of incremental merkle tree

        // TODO: configure?
        let from_nonce = self.mailbox.mailbox().count(None).await.unwrap_or(0);
        self.mailbox.db().update_latest_nonce(from_nonce).unwrap();

        let mailbox_sync = self.mailbox.sync(
            self.as_ref().settings.chains[self.origin_chain.name()]
                .index
                .clone(),
            ContractSyncMetrics::new(self.core.metrics.clone())
        );

        run_all(vec![mailbox_sync, submit.spawn()])
    }
}

#[cfg(test)]
mod test {}
