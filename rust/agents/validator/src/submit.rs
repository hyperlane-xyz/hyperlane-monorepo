use std::assert_eq;
use std::num::NonZeroU64;
use std::sync::Arc;
use std::time::{Duration, Instant};

use eyre::Result;
use hyperlane_base::db::HyperlaneRocksDB;
use hyperlane_core::accumulator::incremental::IncrementalMerkle;
use prometheus::IntGauge;
use tokio::time::sleep;

use hyperlane_base::{CheckpointSyncer, CoreMetrics};
use tracing::{debug, info, trace};

use hyperlane_core::{Checkpoint, CheckpointWithMessageId, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneMessageStore, HyperlaneSigner, HyperlaneSignerExt, Mailbox
};

#[derive(Clone)]
pub(crate) struct ValidatorSubmitter {
    interval: Duration,
    reorg_period: Option<NonZeroU64>,
    signer: Arc<dyn HyperlaneSigner>,
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
        signer: Arc<dyn HyperlaneSigner>,
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

    /// validate local tree's root against latest checkpoint root
    async fn check_consistency(&self, tree: &IncrementalMerkle) -> Result<usize> {
        // do not check consistency until tree is nonempty
        if tree.count() == 0 {
            return Ok(0);
        }

        // do not lag view call for latest checkpoint available to validate against
        if let Ok(latest_checkpoint) = self.mailbox.latest_checkpoint(None).await {
            self.metrics
                .latest_checkpoint_observed
                .set(latest_checkpoint.index as i64);

            if latest_checkpoint.index == tree.index() {
                trace!(count = tree.count(), "Tree up to date");
                assert_eq!(
                    tree.root(),
                    latest_checkpoint.root,
                    "Local root does not match latest checkpoint root"
                );
            } else {
                trace!(
                    lag = latest_checkpoint.index - tree.index(),
                    "Tree out of date"
                );
            }
        }

        Ok(tree.count())
    }

    pub(crate) async fn checkpoint_submitter(self, mut tree: IncrementalMerkle, target_nonce: Option<u32>) -> Result<()> {
        let mut latest_count_checked = self.check_consistency(&tree).await?;

        loop {
            // poll DB for message IDs to ingest
            while let Some(message) = self
                .message_db
                .retrieve_message_by_nonce(tree.count() as u32)
                .await?
            {
                debug!(nonce = message.nonce, "Ingesting leaf to tree");
                let message_id = message.id();
                tree.ingest(message.id());

                let checkpoint_with_id = CheckpointWithMessageId {
                    checkpoint: Checkpoint {
                        index: tree.index(),
                        root: tree.root(),
                        mailbox_address: self.mailbox.address(),
                        mailbox_domain: self.mailbox.domain().into(),
                    },
                    message_id,
                };

                let signed_checkpoint = self.signer.sign(checkpoint_with_id).await?;
                info!(?signed_checkpoint, signer=?self.signer, "Signed checkpoint");
                self.checkpoint_syncer
                    .write_checkpoint(&signed_checkpoint)
                    .await?;

                self.metrics
                    .latest_checkpoint_processed
                    .set(signed_checkpoint.value.index as i64);
            }

            // check consistency of local tree after ingesting messages
            if tree.count() != latest_count_checked {
                latest_count_checked = self.check_consistency(&tree).await?;
            }

            // if target nonce is specified, stop submitting checkpoints after reaching target
            if let Some(target_nonce) = target_nonce {
                if tree.count() as u32 >= target_nonce {
                    info!("Reached target nonce, stopping checkpoint submission");
                    // TODO: exit
                    sleep(self.interval * 100).await;
                }
            }

            sleep(self.interval).await;
        }
    }

    pub(crate) async fn legacy_checkpoint_submitter(self) -> Result<()> {
        // Ensure that the mailbox has > 0 messages before we enter the main
        // validator submit loop. This is to avoid an underflow / reverted
        // call when we invoke the `mailbox.latest_checkpoint()` method,
        // which returns the **index** of the last element in the tree
        // rather than just the size.  See
        // https://github.com/hyperlane-network/hyperlane-monorepo/issues/575 for
        // more details.
        while self.mailbox.count(self.reorg_period).await? == 0 {
            info!("Waiting for first message to mailbox");
            sleep(self.interval).await;
        }

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
