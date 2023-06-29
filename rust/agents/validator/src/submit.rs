use std::num::NonZeroU64;
use std::sync::Arc;
use std::time::{Duration, Instant};
use std::vec;

use eyre::Result;
use prometheus::IntGauge;
use tokio::time::sleep;
use tracing::instrument;
use tracing::{debug, info};

use hyperlane_base::{db::HyperlaneRocksDB, CheckpointSyncer, CoreMetrics};
use hyperlane_core::{
    accumulator::incremental::IncrementalMerkle, Checkpoint, CheckpointWithMessageId,
    HyperlaneChain, HyperlaneContract, HyperlaneDomain, HyperlaneSignerExt, Mailbox,
};
use hyperlane_ethereum::SingletonSignerHandle;

#[derive(Clone)]
pub(crate) struct ValidatorSubmitter {
    interval: Duration,
    reorg_period: Option<NonZeroU64>,
    signer: SingletonSignerHandle,
    mailbox: Arc<dyn Mailbox>,
    checkpoint_syncer: Arc<dyn CheckpointSyncer>,
    message_db: HyperlaneRocksDB,
    metrics: ValidatorSubmitterMetrics,
}

impl ValidatorSubmitter {
    pub(crate) fn new(
        interval: Duration,
        reorg_period: u64,
        mailbox: Arc<dyn Mailbox>,
        signer: SingletonSignerHandle,
        checkpoint_syncer: Arc<dyn CheckpointSyncer>,
        message_db: HyperlaneRocksDB,
        metrics: ValidatorSubmitterMetrics,
    ) -> Self {
        Self {
            reorg_period: NonZeroU64::new(reorg_period),
            interval,
            mailbox,
            signer,
            checkpoint_syncer,
            message_db,
            metrics,
        }
    }

    pub(crate) fn checkpoint(&self, tree: &IncrementalMerkle) -> Checkpoint {
        Checkpoint {
            root: tree.root(),
            index: tree.index(),
            mailbox_address: self.mailbox.address(),
            mailbox_domain: self.mailbox.domain().id(),
        }
    }

    #[instrument(err, skip(self, tree), fields(domain=%self.mailbox.domain()))]
    pub(crate) async fn checkpoint_submitter(
        self,
        mut tree: IncrementalMerkle,
        target_checkpoint: Option<Checkpoint>,
    ) -> Result<()> {
        let mut checkpoint_queue = vec![];

        let mut reached_target = false;

        while !reached_target {
            let correctness_checkpoint = if let Some(c) = target_checkpoint {
                c
            } else {
                // lag by reorg period to match message indexing
                let latest_checkpoint = self.mailbox.latest_checkpoint(self.reorg_period).await?;
                self.metrics
                    .latest_checkpoint_observed
                    .set(latest_checkpoint.index as i64);
                latest_checkpoint
            };

            // ingest available messages from DB
            while let Some(message) = self
                .message_db
                .retrieve_message_by_nonce(tree.count() as u32)?
            {
                debug!(index = message.nonce, "Ingesting leaf to tree");
                let message_id = message.id();
                tree.ingest(message_id);

                let checkpoint = self.checkpoint(&tree);

                checkpoint_queue.push(CheckpointWithMessageId {
                    checkpoint,
                    message_id,
                });

                // compare against every queued checkpoint to prevent ingesting past target
                if checkpoint == correctness_checkpoint {
                    debug!(index = checkpoint.index, "Reached tree consistency");

                    // drain and sign all checkpoints in the queue
                    for queued_checkpoint in checkpoint_queue.drain(..) {
                        let existing = self
                            .checkpoint_syncer
                            .fetch_checkpoint(queued_checkpoint.index)
                            .await?;
                        if existing.is_some() {
                            debug!(
                                index = queued_checkpoint.index,
                                "Checkpoint already submitted"
                            );
                            continue;
                        }

                        let signed_checkpoint = self.signer.sign(queued_checkpoint).await?;
                        self.checkpoint_syncer
                            .write_checkpoint(&signed_checkpoint)
                            .await?;
                        debug!(
                            index = queued_checkpoint.index,
                            "Signed and submitted checkpoint"
                        );

                        // small sleep before signing next checkpoint to avoid rate limiting
                        sleep(Duration::from_millis(100)).await;
                    }

                    info!(index = checkpoint.index, "Signed all queued checkpoints");

                    self.metrics
                        .latest_checkpoint_processed
                        .set(checkpoint.index as i64);

                    // break out of submitter loop if target checkpoint is reached
                    reached_target = target_checkpoint.is_some();
                    break;
                }
            }

            sleep(self.interval).await;
        }

        // TODO: remove this once validator is tolerant of tasks exiting
        loop {
            sleep(Duration::from_secs(u64::MAX)).await;
        }
    }

    pub(crate) async fn legacy_checkpoint_submitter(self) -> Result<()> {
        // current_index will be None if the validator cannot find
        // a previously signed checkpoint
        let mut current_index = self.checkpoint_syncer.latest_index().await?;

        if let Some(current_index) = current_index {
            self.metrics
                .legacy_latest_checkpoint_processed
                .set(current_index as i64);
        }

        // How often to log checkpoint info - once every minute
        let checkpoint_info_log_period = Duration::from_secs(60);
        // The instant in which we last logged checkpoint info, if at all
        let mut latest_checkpoint_info_log: Option<Instant> = None;
        // Returns whether checkpoint info should be logged based off the
        // checkpoint_info_log_period having elapsed since the last log.
        // Sets latest_checkpoint_info_log to the current instant if true.
        let mut should_log_checkpoint_info = || {
            if let Some(instant) = latest_checkpoint_info_log {
                if instant.elapsed() < checkpoint_info_log_period {
                    return false;
                }
            }
            latest_checkpoint_info_log = Some(Instant::now());
            true
        };

        loop {
            // Check the latest checkpoint
            let latest_checkpoint = self.mailbox.latest_checkpoint(self.reorg_period).await?;

            self.metrics
                .legacy_latest_checkpoint_observed
                .set(latest_checkpoint.index as i64);

            // Occasional info to make it clear to a validator operator whether things are
            // working correctly without using the debug log level.
            if should_log_checkpoint_info() {
                info!(
                    latest_signed_checkpoint_index=?current_index,
                    latest_known_checkpoint_index=?latest_checkpoint.index,
                    "Latest checkpoint infos"
                );
            }

            debug!(
                latest_signed_checkpoint_index=?current_index,
                latest_known_checkpoint_index=?latest_checkpoint.index,
                "Polled latest checkpoint"
            );

            // If current_index is None, we were unable to find a previously
            // signed checkpoint, and we should sign the latest checkpoint.
            // This ensures that we still sign even if the latest checkpoint
            // has index 0.
            if current_index
                .map(|i| i < latest_checkpoint.index)
                .unwrap_or(true)
            {
                let signed_checkpoint = self.signer.sign(latest_checkpoint).await?;

                info!(signed_checkpoint = ?signed_checkpoint, signer=?self.signer, "Signed new latest checkpoint");
                current_index = Some(latest_checkpoint.index);

                self.checkpoint_syncer
                    .legacy_write_checkpoint(&signed_checkpoint)
                    .await?;
                self.metrics
                    .legacy_latest_checkpoint_processed
                    .set(signed_checkpoint.value.index as i64);
            }

            sleep(self.interval).await;
        }
    }
}

#[derive(Clone)]
pub(crate) struct ValidatorSubmitterMetrics {
    latest_checkpoint_observed: IntGauge,
    latest_checkpoint_processed: IntGauge,
    legacy_latest_checkpoint_observed: IntGauge,
    legacy_latest_checkpoint_processed: IntGauge,
}

impl ValidatorSubmitterMetrics {
    pub fn new(metrics: &CoreMetrics, mailbox_chain: &HyperlaneDomain) -> Self {
        let chain_name = mailbox_chain.name();
        Self {
            legacy_latest_checkpoint_observed: metrics
                .latest_checkpoint()
                .with_label_values(&["legacy_validator_observed", chain_name]),
            legacy_latest_checkpoint_processed: metrics
                .latest_checkpoint()
                .with_label_values(&["legacy_validator_processed", chain_name]),
            latest_checkpoint_observed: metrics
                .latest_checkpoint()
                .with_label_values(&["validator_observed", chain_name]),
            latest_checkpoint_processed: metrics
                .latest_checkpoint()
                .with_label_values(&["validator_processed", chain_name]),
        }
    }
}
