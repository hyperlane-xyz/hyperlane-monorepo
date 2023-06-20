use std::num::NonZeroU64;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use eyre::Result;
use tokio::{task::JoinHandle, time::sleep};
use tracing::{error, info, info_span, instrument::Instrumented, warn, Instrument};

use hyperlane_base::{
    db::{HyperlaneRocksDB, DB},
    run_all, BaseAgent, CheckpointSyncer, ContractSyncMetrics, CoreMetrics, HyperlaneAgentCore,
    MessageContractSync,
};
use hyperlane_core::{
    accumulator::incremental::IncrementalMerkle, Announcement, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneSigner, HyperlaneSignerExt, Mailbox, ValidatorAnnounce, H256, U256,
};
use hyperlane_ethereum::{SingletonSigner, SingletonSignerHandle};

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
    signer: SingletonSignerHandle,
    // temporary holder until `run` is called
    signer_instance: Option<Box<SingletonSigner>>,
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

        // Intentionally using hyperlane_ethereum for the validator's signer
        let (signer_instance, signer) = SingletonSigner::new(settings.validator.build().await?);

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
                Arc::new(msg_db.clone()),
            )
            .await?
            .into();

        Ok(Self {
            origin_chain: settings.origin_chain,
            core,
            db: msg_db,
            mailbox: mailbox.into(),
            message_sync,
            validator_announce: validator_announce.into(),
            signer,
            signer_instance: Some(Box::new(signer_instance)),
            reorg_period: settings.reorg_period,
            interval: settings.interval,
            checkpoint_syncer,
        })
    }

    #[allow(clippy::async_yields_async)]
    async fn run(mut self) -> Instrumented<JoinHandle<Result<()>>> {
        let mut tasks = vec![];

        if let Some(signer_instance) = self.signer_instance.take() {
            tasks.push(
                tokio::spawn(async move {
                    signer_instance.run().await;
                    Ok(())
                })
                .instrument(info_span!("SingletonSigner")),
            );
        }

        // announce the validator after spawning the signer task
        self.announce().await.expect("Failed to announce validator");

        let reorg_period = NonZeroU64::new(self.reorg_period);

        // Ensure that the mailbox has count > 0 before we begin indexing
        // messages or submitting checkpoints.
        while self
            .mailbox
            .count(reorg_period)
            .await
            .expect("Failed to get count of mailbox")
            == 0
        {
            info!("Waiting for first message to mailbox");
            sleep(self.interval).await;
        }

        tasks.push(self.run_message_sync().await);
        for checkpoint_sync_task in self.run_checkpoint_submitters().await {
            tasks.push(checkpoint_sync_task);
        }

        run_all(tasks)
    }
}

impl Validator {
    async fn run_message_sync(&self) -> Instrumented<JoinHandle<Result<()>>> {
        let index_settings = self.as_ref().settings.chains[self.origin_chain.name()]
            .index
            .clone();
        let contract_sync = self.message_sync.clone();
        let cursor = contract_sync
            .forward_backward_message_sync_cursor(index_settings.chunk_size)
            .await;
        tokio::spawn(async move {
            contract_sync
                .clone()
                .sync("dispatched_messages", cursor)
                .await
        })
        .instrument(info_span!("MailboxMessageSyncer"))
    }

    async fn run_checkpoint_submitters(&self) -> Vec<Instrumented<JoinHandle<Result<()>>>> {
        let submitter = ValidatorSubmitter::new(
            self.interval,
            self.reorg_period,
            self.mailbox.clone(),
            self.signer.clone(),
            self.checkpoint_syncer.clone(),
            self.db.clone(),
            ValidatorSubmitterMetrics::new(&self.core.metrics, &self.origin_chain),
        );

        let empty_tree = IncrementalMerkle::default();
        let reorg_period = NonZeroU64::new(self.reorg_period);
        let tip_tree = self
            .mailbox
            .tree(reorg_period)
            .await
            .expect("failed to get mailbox tree");
        assert!(tip_tree.count() > 0, "mailbox tree is empty");
        let backfill_target = submitter.checkpoint(&tip_tree);

        let legacy_submitter = submitter.clone();
        let backfill_submitter = submitter.clone();

        let mut tasks = vec![];
        tasks.push(
            tokio::spawn(async move {
                backfill_submitter
                    .checkpoint_submitter(empty_tree, Some(backfill_target))
                    .await
            })
            .instrument(info_span!("BackfillCheckpointSubmitter")),
        );

        tasks.push(
            tokio::spawn(async move { submitter.checkpoint_submitter(tip_tree, None).await })
                .instrument(info_span!("TipCheckpointSubmitter")),
        );
        tasks.push(
            tokio::spawn(async move { legacy_submitter.legacy_checkpoint_submitter().await })
                .instrument(info_span!("LegacyCheckpointSubmitter")),
        );

        tasks
    }

    async fn announce(&self) -> Result<()> {
        // Sign and post the validator announcement
        let announcement = Announcement {
            validator: self.signer.eth_address(),
            mailbox_address: self.mailbox.address(),
            mailbox_domain: self.mailbox.domain().id(),
            storage_location: self.checkpoint_syncer.announcement_location(),
        };
        let signed_announcement = self.signer.sign(announcement.clone()).await?;
        self.checkpoint_syncer
            .write_announcement(&signed_announcement)
            .await?;

        // Ensure that the validator has announced themselves before we enter
        // the main validator submit loop. This is to avoid a situation in
        // which the validator is signing checkpoints but has not announced
        // their locations, which makes them functionally unusable.
        let validators: [H256; 1] = [self.signer.eth_address().into()];
        loop {
            info!("Checking for validator announcement");
            if let Some(locations) = self
                .validator_announce
                .get_announced_storage_locations(&validators)
                .await?
                .first()
            {
                if locations.contains(&self.checkpoint_syncer.announcement_location()) {
                    info!("Validator has announced signature storage location");
                    break;
                }
                info!("Validator has not announced signature storage location");
                let balance_delta = self
                    .validator_announce
                    .announce_tokens_needed(signed_announcement.clone())
                    .await?;
                if balance_delta > U256::zero() {
                    warn!(
                        tokens_needed=%balance_delta,
                        validator_address=?announcement.validator,
                        "Please send tokens to the validator address to announce",
                    );
                    sleep(self.interval).await;
                } else {
                    let outcome = self
                        .validator_announce
                        .announce(signed_announcement.clone(), None)
                        .await?;
                    if !outcome.executed {
                        error!(
                            hash=?outcome.txid,
                            "Transaction attempting to announce validator reverted"
                        );
                    }
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod test {}
