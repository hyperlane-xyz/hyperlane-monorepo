use std::num::NonZeroU64;
use std::sync::Arc;
use std::time::{Duration, Instant};
use std::vec;

use eyre::{bail, Result};
use hyperlane_core::MerkleTreeHook;
use prometheus::IntGauge;
use tokio::time::sleep;
use tracing::{debug, info};
use tracing::{error, instrument};

use hyperlane_base::{db::HyperlaneRocksDB, CheckpointSyncer, CoreMetrics};
use hyperlane_core::{
    accumulator::incremental::IncrementalMerkle, Checkpoint, CheckpointWithMessageId,
    HyperlaneChain, HyperlaneContract, HyperlaneDomain, HyperlaneSignerExt,
};
use hyperlane_ethereum::SingletonSignerHandle;

#[derive(Clone)]
pub(crate) struct ValidatorSubmitter {
    interval: Duration,
    reorg_period: Option<NonZeroU64>,
    signer: SingletonSignerHandle,
    merkle_tree_hook: Arc<dyn MerkleTreeHook>,
    checkpoint_syncer: Arc<dyn CheckpointSyncer>,
    message_db: HyperlaneRocksDB,
    metrics: ValidatorSubmitterMetrics,
}

impl ValidatorSubmitter {
    pub(crate) fn new(
        interval: Duration,
        reorg_period: u64,
        merkle_tree_hook: Arc<dyn MerkleTreeHook>,
        signer: SingletonSignerHandle,
        checkpoint_syncer: Arc<dyn CheckpointSyncer>,
        message_db: HyperlaneRocksDB,
        metrics: ValidatorSubmitterMetrics,
    ) -> Self {
        Self {
            reorg_period: NonZeroU64::new(reorg_period),
            interval,
            merkle_tree_hook,
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
            merkle_tree_hook_address: self.merkle_tree_hook.address(),
            mailbox_domain: self.merkle_tree_hook.domain().id(),
        }
    }

    /// Submits signed checkpoints.
    /// If a target checkpoint is provided, the provided tree must not be behind it, and
    /// the submitter will only submit checkpoints until it reaches the target checkpoint.
    /// If a target checkpoint is not provided, the submitter will submit checkpoints indefinitely.
    #[instrument(err, skip(self, tree), fields(domain=%self.merkle_tree_hook.domain()))]
    pub(crate) async fn checkpoint_submitter(
        self,
        mut tree: IncrementalMerkle,
        target_checkpoint: Option<Checkpoint>,
    ) -> Result<()> {
        // If the target checkpoint is provided, the provided tree must not be behind it.
        if let Some(target) = target_checkpoint {
            assert!(tree.index() <= target.index);
        }

        loop {
            let correctness_checkpoint = if let Some(c) = target_checkpoint {
                c
            } else {
                // lag by reorg period to match message indexing
                let latest_checkpoint = self
                    .merkle_tree_hook
                    .latest_checkpoint(self.reorg_period)
                    .await?;
                self.metrics
                    .latest_checkpoint_observed
                    .set(latest_checkpoint.index as i64);
                latest_checkpoint
            };

            // This can only happen if target_checkpoint is None and the latest checkpoint
            // fetched from onchain has an index that is behind the tree's index.
            // The initial tree parameter, which is sometimes constructed from an onchain
            // call to MerkleTreeHook.tree(), may have an index that is ahead of the latest checkpoint
            // due to the call being made against a block later than the latest_checkpoint() call.
            // This ideally shouldn't happen, but RPC providers are unreliable and sometimes make
            // calls against inconsistent block tips.
            //
            // In this case, we just sleep a bit until we fetch a new latest checkpoint
            // that at least meets the tree.
            if correctness_checkpoint.index < tree.index() {
                sleep(self.interval).await;
                break;
            }

            self.submit_checkpoints_until_correctness_checkpoint(
                &mut tree,
                &correctness_checkpoint,
            )
            .await?;

            // If target checkpoint is Some and we've gotten this far,
            // we've successfully reached the target checkpoint and break.
            if target_checkpoint.is_some() {
                info!(?target_checkpoint, "Successfully reached target checkpoint");
                break;
            } else {
                // Only update the latest checkpoint processed metric if we're
                // not targeting a specific checkpoint and instead want to keep
                // signing checkpoints indefinitely as they come in.
                self.metrics
                    .latest_checkpoint_processed
                    .set(correctness_checkpoint.index as i64);
            }
        }

        // TODO: remove this once validator is tolerant of tasks exiting.
        loop {
            sleep(Duration::from_secs(u64::MAX)).await;
        }
    }

    /// Submits signed checkpoints relating to the given tree until the correctness checkpoint (inclusive).
    async fn submit_checkpoints_until_correctness_checkpoint(
        &self,
        tree: &mut IncrementalMerkle,
        correctness_checkpoint: &Checkpoint,
    ) -> Result<()> {
        // This should never be called with a tree that is ahead of the correctness checkpoint.
        assert!(correctness_checkpoint.index >= tree.index());

        // All intermediate checkpoints will be stored here and signed once the correctness
        // checkpoint is reached.
        let mut checkpoint_queue = vec![];

        // If the correctness checkpoint is ahead of the tree, we need to ingest more messages.
        //
        // tree.index() will panic if the tree is empty, so we use tree.count() instead.
        while correctness_checkpoint.index + 1 > tree.count() as u32 {
            if let Some(insertion) = self
                .message_db
                .retrieve_merkle_tree_insertion_by_leaf_index(&(tree.count() as u32))?
            {
                debug!(
                    index = insertion.index(),
                    queue_length = checkpoint_queue.len(),
                    "Ingesting leaf to tree"
                );
                let message_id = insertion.message_id();
                tree.ingest(message_id);

                let checkpoint = self.checkpoint(&tree);

                checkpoint_queue.push(CheckpointWithMessageId {
                    checkpoint,
                    message_id,
                });
            } else {
                // If we haven't yet indexed the next merkle tree insertion but know that
                // it will soon exist (because the correctness checkpoint), wait a bit and
                // try again.
                sleep(Duration::from_millis(100)).await
            }
        }

        // At this point we know that correctness_checkpoint.index == tree.index().

        let checkpoint = self.checkpoint(&tree);

        if checkpoint == *correctness_checkpoint {
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

            info!(
                index = checkpoint.index,
                "Signed all queued checkpoints until index"
            );

            self.metrics
                .latest_checkpoint_processed
                .set(checkpoint.index as i64);
        } else {
            // Bad news, bail
            error!(
                ?checkpoint,
                ?correctness_checkpoint,
                "Incorrect tree root, something went wrong"
            );
            bail!("Incorrect tree root, something went wrong");
        }

        Ok(())
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
            let latest_checkpoint = self
                .merkle_tree_hook
                .latest_checkpoint(self.reorg_period)
                .await?;

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
