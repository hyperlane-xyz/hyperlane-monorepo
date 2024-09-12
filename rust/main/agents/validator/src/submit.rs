use std::num::NonZeroU64;
use std::sync::Arc;
use std::time::{Duration, Instant};
use std::vec;

use hyperlane_core::rpc_clients::call_and_retry_indefinitely;
use hyperlane_core::{ChainResult, MerkleTreeHook};
use prometheus::IntGauge;
use tokio::time::sleep;
use tracing::{debug, error, info};

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

    /// Submits signed checkpoints from index 0 until the target checkpoint (inclusive).
    /// Runs idly forever once the target checkpoint is reached to avoid exiting the task.
    pub(crate) async fn backfill_checkpoint_submitter(self, target_checkpoint: Checkpoint) {
        let mut tree = IncrementalMerkle::default();
        self.submit_checkpoints_until_correctness_checkpoint(&mut tree, &target_checkpoint)
            .await;

        info!(
            ?target_checkpoint,
            "Backfill checkpoint submitter successfully reached target checkpoint"
        );
    }

    /// Submits signed checkpoints indefinitely, starting from the `tree`.
    pub(crate) async fn checkpoint_submitter(self, mut tree: IncrementalMerkle) {
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
            // Lag by reorg period because this is our correctness checkpoint.
            let latest_checkpoint = call_and_retry_indefinitely(|| {
                let merkle_tree_hook = self.merkle_tree_hook.clone();
                Box::pin(async move { merkle_tree_hook.latest_checkpoint(self.reorg_period).await })
            })
            .await;

            self.metrics
                .latest_checkpoint_observed
                .set(latest_checkpoint.index as i64);

            if should_log_checkpoint_info() {
                info!(
                    ?latest_checkpoint,
                    tree_count = tree.count(),
                    "Latest checkpoint"
                );
            }

            // This may occur e.g. if RPC providers are unreliable and make calls against
            // inconsistent block tips.
            //
            // In this case, we just sleep a bit until we fetch a new latest checkpoint
            // that at least meets the tree.
            if tree_exceeds_checkpoint(&latest_checkpoint, &tree) {
                debug!(
                    ?latest_checkpoint,
                    tree_count = tree.count(),
                    "Latest checkpoint is behind tree, sleeping briefly"
                );
                sleep(self.interval).await;
                continue;
            }
            self.submit_checkpoints_until_correctness_checkpoint(&mut tree, &latest_checkpoint)
                .await;

            self.metrics
                .latest_checkpoint_processed
                .set(latest_checkpoint.index as i64);

            sleep(self.interval).await;
        }
    }

    /// Submits signed checkpoints relating to the given tree until the correctness checkpoint (inclusive).
    /// Only submits the signed checkpoints once the correctness checkpoint is reached.
    async fn submit_checkpoints_until_correctness_checkpoint(
        &self,
        tree: &mut IncrementalMerkle,
        correctness_checkpoint: &Checkpoint,
    ) {
        // This should never be called with a tree that is ahead of the correctness checkpoint.
        assert!(
            !tree_exceeds_checkpoint(correctness_checkpoint, tree),
            "tree (count: {}) is ahead of correctness checkpoint {:?}",
            tree.count(),
            correctness_checkpoint,
        );

        // All intermediate checkpoints will be stored here and signed once the correctness
        // checkpoint is reached.
        let mut checkpoint_queue = vec![];

        // If the correctness checkpoint is ahead of the tree, we need to ingest more messages.
        //
        // tree.index() will panic if the tree is empty, so we use tree.count() instead
        // and convert the correctness_checkpoint.index to a count by adding 1.
        while tree.count() as u32 <= correctness_checkpoint.index {
            if let Some(insertion) = self
                .message_db
                .retrieve_merkle_tree_insertion_by_leaf_index(&(tree.count() as u32))
                .unwrap_or_else(|err| {
                    panic!(
                        "Error fetching merkle tree insertion for leaf index {}: {}",
                        tree.count(),
                        err
                    )
                })
            {
                debug!(
                    index = insertion.index(),
                    queue_length = checkpoint_queue.len(),
                    "Ingesting leaf to tree"
                );
                let message_id = insertion.message_id();
                tree.ingest(message_id);

                let checkpoint = self.checkpoint(tree);

                checkpoint_queue.push(CheckpointWithMessageId {
                    checkpoint,
                    message_id,
                });
            } else {
                // If we haven't yet indexed the next merkle tree insertion but know that
                // it will soon exist (because we know the correctness checkpoint), wait a bit and
                // try again.
                sleep(Duration::from_millis(100)).await
            }
        }

        // At this point we know that correctness_checkpoint.index == tree.index().
        assert_eq!(
            correctness_checkpoint.index,
            tree.index(),
            "correctness checkpoint index {} != tree index {}",
            correctness_checkpoint.index,
            tree.index(),
        );

        let checkpoint = self.checkpoint(tree);

        // If the tree's checkpoint doesn't match the correctness checkpoint, something went wrong
        // and we bail loudly.
        if checkpoint != *correctness_checkpoint {
            error!(
                ?checkpoint,
                ?correctness_checkpoint,
                "Incorrect tree root, something went wrong"
            );
            panic!("Incorrect tree root, something went wrong");
        }

        if !checkpoint_queue.is_empty() {
            info!(
                index = checkpoint.index,
                queue_len = checkpoint_queue.len(),
                "Reached tree consistency"
            );
            self.sign_and_submit_checkpoints(checkpoint_queue).await;

            info!(
                index = checkpoint.index,
                "Signed all queued checkpoints until index"
            );
        }
    }

    async fn sign_and_submit_checkpoint(
        &self,
        checkpoint: CheckpointWithMessageId,
    ) -> ChainResult<()> {
        let existing = self
            .checkpoint_syncer
            .fetch_checkpoint(checkpoint.index)
            .await?;
        if existing.is_some() {
            debug!(index = checkpoint.index, "Checkpoint already submitted");
            return Ok(());
        }
        let signed_checkpoint = self.signer.sign(checkpoint).await?;
        self.checkpoint_syncer
            .write_checkpoint(&signed_checkpoint)
            .await?;
        debug!(index = checkpoint.index, "Signed and submitted checkpoint");

        // TODO: move these into S3 implementations
        // small sleep before signing next checkpoint to avoid rate limiting
        sleep(Duration::from_millis(100)).await;
        Ok(())
    }

    /// Signs and submits any previously unsubmitted checkpoints.
    async fn sign_and_submit_checkpoints(&self, checkpoints: Vec<CheckpointWithMessageId>) {
        let last_checkpoint = checkpoints.as_slice()[checkpoints.len() - 1];
        // Submits checkpoints to the store in reverse order. This speeds up processing historic checkpoints (those before the validator is spun up),
        // since those are the most likely to make messages become processable.
        // A side effect is that new checkpoints will also be submitted in reverse order.
        for queued_checkpoint in checkpoints.into_iter().rev() {
            // certain checkpoint stores rate limit very aggressively, so we retry indefinitely
            call_and_retry_indefinitely(|| {
                let self_clone = self.clone();
                Box::pin(async move {
                    self_clone
                        .sign_and_submit_checkpoint(queued_checkpoint)
                        .await?;
                    Ok(())
                })
            })
            .await;
        }

        call_and_retry_indefinitely(|| {
            let self_clone = self.clone();
            Box::pin(async move {
                self_clone
                    .checkpoint_syncer
                    .update_latest_index(last_checkpoint.index)
                    .await?;
                Ok(())
            })
        })
        .await;
    }
}

/// Returns whether the tree exceeds the checkpoint.
fn tree_exceeds_checkpoint(checkpoint: &Checkpoint, tree: &IncrementalMerkle) -> bool {
    // tree.index() will panic if the tree is empty, so we use tree.count() instead
    // and convert the correctness_checkpoint.index to a count by adding 1.
    checkpoint.index + 1 < tree.count() as u32
}

#[derive(Clone)]
pub(crate) struct ValidatorSubmitterMetrics {
    latest_checkpoint_observed: IntGauge,
    latest_checkpoint_processed: IntGauge,
}

impl ValidatorSubmitterMetrics {
    pub fn new(metrics: &CoreMetrics, mailbox_chain: &HyperlaneDomain) -> Self {
        let chain_name = mailbox_chain.name();
        Self {
            latest_checkpoint_observed: metrics
                .latest_checkpoint()
                .with_label_values(&["validator_observed", chain_name]),
            latest_checkpoint_processed: metrics
                .latest_checkpoint()
                .with_label_values(&["validator_processed", chain_name]),
        }
    }
}
