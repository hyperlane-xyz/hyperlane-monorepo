use std::time::Duration;
use std::sync::Arc;

use async_trait::async_trait;
use eyre::Result;
use hyperlane_base::db::HyperlaneRocksDB;
use hyperlane_base::MessageContractSync;
use tokio::task::JoinHandle;
use tracing::{Instrument, info_span};
use tracing::instrument::Instrumented;

use hyperlane_base::{
    db::DB, run_all, BaseAgent, CheckpointSyncer, ContractSyncMetrics, CoreMetrics,
    HyperlaneAgentCore,
};
use hyperlane_core::{HyperlaneDomain, HyperlaneSigner, Mailbox, ValidatorAnnounce};

use crate::{
    settings::ValidatorSettings, submit::ValidatorSubmitter, submit::ValidatorSubmitterMetrics,
};

/// A validator agent
#[derive(Debug)]
pub struct Validator {
    origin_chain: HyperlaneDomain,
    core: HyperlaneAgentCore,
    db: HyperlaneRocksDB,
    message_sync: Arc<MessageContractSync>,
    mailbox: Arc<dyn Mailbox>,
    validator_announce: Arc<dyn ValidatorAnnounce>,
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
        let msg_db = HyperlaneRocksDB::new(&settings.origin_chain, db);

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
            .await?;

        let validator_announce = settings
            .build_validator_announce(&settings.origin_chain, &metrics)
            .await?;

        let contract_sync_metrics = Arc::new(ContractSyncMetrics::new(&metrics));

        let message_sync = settings
            .build_message_indexer(
                &settings.origin_chain,
                &metrics,
                &contract_sync_metrics,
                Arc::new(msg_db.clone())
            )
            .await?.into();

        Ok(Self {
            origin_chain: settings.origin_chain,
            core,
            db: msg_db,
            mailbox: mailbox.into(),
            message_sync,
            validator_announce: validator_announce.into(),
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
            self.validator_announce.clone(),
            self.signer.clone(),
            self.checkpoint_syncer.clone(),
            self.db.clone(),
            ValidatorSubmitterMetrics::new(&self.core.metrics, &self.origin_chain),
        );

        let mut tasks = vec![];

        tasks.push(self.run_message_sync().await);
        tasks.push(submit.clone().spawn_legacy());
        tasks.push(submit.spawn());

        run_all(tasks)
    }
}

impl Validator {
    async fn run_message_sync(&self) -> Instrumented<JoinHandle<eyre::Result<()>>> {
        let index_settings = self.as_ref().settings.chains[self.origin_chain.name()]
            .index
            .clone();
        let contract_sync = self.message_sync.clone();
        let cursor = contract_sync
            .forward_backward_message_sync_cursor(index_settings)
            .await;
        tokio::spawn(async move {
            contract_sync
                .clone()
                .sync("dispatched_messages", cursor)
                .await
        })
        .instrument(info_span!("ContractSync"))
    }
}

#[cfg(test)]
mod test {}
