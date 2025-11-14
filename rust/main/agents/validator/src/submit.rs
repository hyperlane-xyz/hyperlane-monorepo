use std::sync::Arc;
use std::time::{Duration, Instant};
use std::vec;

use futures::future::join_all;
use prometheus::IntGauge;
use tokio::time::sleep;
use tracing::{debug, error, info, warn};

use hyperlane_base::db::HyperlaneDb;
use hyperlane_base::{CheckpointSyncer, CoreMetrics};
use hyperlane_core::rpc_clients::call_and_retry_indefinitely;
use hyperlane_core::{
    accumulator::incremental::IncrementalMerkle, Checkpoint, CheckpointAtBlock,
    CheckpointWithMessageId, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneSignerExt, IncrementalMerkleAtBlock,
};
use hyperlane_core::{
    ChainResult, HyperlaneSigner, MerkleTreeHook, ReorgEvent, ReorgPeriod, SignedType,
};
use hyperlane_ethereum::{Signers, SingletonSignerHandle};

use crate::reorg_reporter::ReorgReporter;

#[derive(Clone)]
pub(crate) struct ValidatorSubmitter {
    interval: Duration,
    reorg_period: ReorgPeriod,
    #[allow(unused)]
    singleton_signer: SingletonSignerHandle,
    signer: Signers,
    merkle_tree_hook: Arc<dyn MerkleTreeHook>,
    checkpoint_syncer: Arc<dyn CheckpointSyncer>,
    db: Arc<dyn HyperlaneDb>,
    metrics: ValidatorSubmitterMetrics,
    max_sign_concurrency: usize,
    reorg_reporter: Arc<dyn ReorgReporter>,
}

impl ValidatorSubmitter {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        interval: Duration,
        reorg_period: ReorgPeriod,
        merkle_tree_hook: Arc<dyn MerkleTreeHook>,
        singleton_signer: SingletonSignerHandle,
        signer: Signers,
        checkpoint_syncer: Arc<dyn CheckpointSyncer>,
        db: Arc<dyn HyperlaneDb>,
        metrics: ValidatorSubmitterMetrics,
        max_sign_concurrency: usize,
        reorg_reporter: Arc<dyn ReorgReporter>,
    ) -> Self {
        Self {
            reorg_period,
            interval,
            merkle_tree_hook,
            singleton_signer,
            signer,
            checkpoint_syncer,
            db,
            metrics,
            max_sign_concurrency,
            reorg_reporter,
        }
    }

    pub(crate) fn checkpoint(&self, tree: &IncrementalMerkle) -> Checkpoint {
        Checkpoint {
            merkle_tree_hook_address: self.merkle_tree_hook.address(),
            mailbox_domain: self.merkle_tree_hook.domain().id(),
            root: tree.root(),
            index: tree.index(),
        }
    }

    pub(crate) fn checkpoint_at_block(&self, tree: &IncrementalMerkleAtBlock) -> CheckpointAtBlock {
        let checkpoint = self.checkpoint(&tree.tree);

        CheckpointAtBlock {
            checkpoint,
            block_height: tree.block_height,
        }
    }

    /// Submits signed checkpoints from index 0 until the target checkpoint (inclusive).
    /// Runs idly forever once the target checkpoint is reached to avoid exiting the task.
    pub(crate) async fn backfill_checkpoint_submitter(self, target_checkpoint: CheckpointAtBlock) {
        let mut tree = IncrementalMerkle::default();
        self.submit_checkpoints_until_correctness_checkpoint(&mut tree, &target_checkpoint)
            .await;

        info!(
            ?target_checkpoint,
            "Backfill checkpoint submitter successfully reached target checkpoint"
        );

        // Set that backfill is completed in metrics
        self.metrics.backfill_complete.set(1);
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
                let reorg_period = self.reorg_period.clone();
                Box::pin(async move { merkle_tree_hook.latest_checkpoint(&reorg_period).await })
            })
            .await;

            self.metrics
                .set_latest_checkpoint_observed(&latest_checkpoint);

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

            // Set that initial consistency has been reached on first loop run. Subsequent runs are idempotent.
            self.metrics.reached_initial_consistency.set(1);

            sleep(self.interval).await;
        }
    }

    /// Submits signed checkpoints relating to the given tree until the correctness checkpoint (inclusive).
    /// Only submits the signed checkpoints once the correctness checkpoint is reached.
    async fn submit_checkpoints_until_correctness_checkpoint(
        &self,
        tree: &mut IncrementalMerkle,
        correctness_checkpoint: &CheckpointAtBlock,
    ) {
        let start = Instant::now();
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
            let res = self
                .db
                .retrieve_merkle_tree_insertion_by_leaf_index(&(tree.count() as u32))
                .expect("Failed to fetch merkle tree insertion");

            let insertion = match res {
                Some(insertion) => insertion,
                None => {
                    // If we haven't yet indexed the next merkle tree insertion but know that
                    // it will soon exist (because we know the correctness checkpoint), wait a bit and
                    // try again.
                    sleep(Duration::from_millis(100)).await;
                    continue;
                }
            };

            let message_id = insertion.message_id();
            tree.ingest(message_id);

            let checkpoint = self.checkpoint(tree);

            checkpoint_queue.push(CheckpointWithMessageId {
                checkpoint,
                message_id,
            });
        }

        info!(
            root = ?tree.root(),
            queue_length = checkpoint_queue.len(),
            "Ingested leaves into in-memory merkle tree"
        );

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
        if checkpoint != correctness_checkpoint.checkpoint {
            let reorg_event = ReorgEvent::new(
                tree.root(),
                correctness_checkpoint.root,
                checkpoint.index,
                chrono::Utc::now().timestamp() as u64,
                self.reorg_period.clone(),
            );
            error!(
                ?checkpoint,
                ?correctness_checkpoint,
                ?reorg_event,
                "Incorrect tree root. Most likely a reorg has occurred. Please reach out for help, this is a potentially serious error impacting signed messages. Do NOT forcefully resume operation of this validator. Keep it crashlooping or shut down until you receive support."
            );

            if let Some(height) = correctness_checkpoint.block_height {
                self.reorg_reporter.report_at_block(height).await;
            } else {
                info!("Blockchain does not support block height, reporting with reorg period");
                self.reorg_reporter
                    .report_with_reorg_period(&self.reorg_period)
                    .await;
            }

            let mut panic_message = "Incorrect tree root. Most likely a reorg has occurred. Please reach out for help, this is a potentially serious error impacting signed messages. Do NOT forcefully resume operation of this validator. Keep it crashlooping or shut down until you receive support.".to_owned();
            if let Err(e) = self
                .checkpoint_syncer
                .write_reorg_status(&reorg_event)
                .await
            {
                panic_message.push_str(&format!(
                    " Reorg troubleshooting details couldn't be written to checkpoint storage: {e}"
                ));
            }
            panic!("{panic_message}");
        }

        tracing::info!(
            elapsed=?start.elapsed(),
            checkpoint_queue_len = checkpoint_queue.len(),
            "Checkpoint submitter reached correctness checkpoint"
        );

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

    async fn sign_checkpoint(
        &self,
        checkpoint: CheckpointWithMessageId,
    ) -> ChainResult<SignedType<CheckpointWithMessageId>> {
        let signer_retries = 5;

        for i in 0..signer_retries {
            match self.signer.sign(checkpoint).await {
                Ok(signed_checkpoint) => return Ok(signed_checkpoint),
                Err(err) => {
                    tracing::warn!(
                        ?checkpoint,
                        attempt = i,
                        retries = signer_retries,
                        ?err,
                        "Error signing checkpoint with direct signer"
                    );
                    sleep(Duration::from_millis(100)).await;
                }
            }
        }

        tracing::warn!(
            ?checkpoint,
            retries = signer_retries,
            "Error signing checkpoint with direct signer after all retries, falling back to singleton signer"
        );

        // Now try the singleton signer as a last resort
        Ok(self.singleton_signer.sign(checkpoint).await?)
    }

    async fn sign_and_submit_checkpoint(
        &self,
        checkpoint: CheckpointWithMessageId,
    ) -> ChainResult<()> {
        let start = Instant::now();
        let existing = self
            .checkpoint_syncer
            .fetch_checkpoint(checkpoint.index)
            .await?;
        tracing::trace!(
            elapsed=?start.elapsed(),
            "Fetched checkpoint from checkpoint storage",
        );

        if let Some(existing) = existing.as_ref() {
            let existing_signer = existing.recover()?;
            let signer = self.signer.eth_address();
            if existing_signer == signer && existing.value == checkpoint {
                debug!(index = checkpoint.index, "Checkpoint already submitted");
                return Ok(());
            } else {
                warn!(
                    index = checkpoint.index,
                    existing_checkpoint = ?existing.value,
                    existing_signer = ?existing_signer,
                    new_checkpoint = ?checkpoint,
                    new_signer = ?signer,
                    "Checkpoint already submitted, but with different values, overwriting"
                );
            }
        }

        let start = Instant::now();
        let signed_checkpoint = self.sign_checkpoint(checkpoint).await?;
        tracing::trace!(
            elapsed=?start.elapsed(),
            "Signed checkpoint",
        );

        let start = Instant::now();
        self.checkpoint_syncer
            .write_checkpoint(&signed_checkpoint)
            .await?;
        tracing::trace!(
            elapsed=?start.elapsed(),
            "Stored checkpoint",
        );

        // TODO: move these into S3 implementations
        // small sleep before signing next checkpoint to avoid rate limiting
        sleep(Duration::from_millis(100)).await;
        Ok(())
    }

    /// Signs and submits any previously unsubmitted checkpoints.
    async fn sign_and_submit_checkpoints(&self, mut checkpoints: Vec<CheckpointWithMessageId>) {
        // The checkpoints are ordered by index, so the last one is the highest index.
        let last_checkpoint_index = match checkpoints.last() {
            Some(c) => c.index,
            None => return,
        };

        let arc_self = Arc::new(self.clone());

        let mut first_chunk = true;

        while !checkpoints.is_empty() {
            let start = Instant::now();

            // Take a chunk of checkpoints, starting with the highest index.
            // This speeds up processing historic checkpoints (those before the validator is spun up),
            // since those are the most likely to make messages become processable.
            // A side effect is that new checkpoints will also be submitted in reverse order.

            // This logic is a bit awkward, but we want control over the chunks so we can also
            // write the latest index to the checkpoint storage after the first chunk is successful.
            let mut chunk = Vec::with_capacity(self.max_sign_concurrency);
            for _ in 0..self.max_sign_concurrency {
                if let Some(cp) = checkpoints.pop() {
                    chunk.push(cp);
                } else {
                    break;
                }
            }

            let chunk_len = chunk.len();

            let futures = chunk.into_iter().map(|checkpoint| {
                let self_clone = arc_self.clone();
                call_and_retry_indefinitely(move || {
                    let self_clone = self_clone.clone();
                    Box::pin(async move {
                        let start = Instant::now();
                        let checkpoint_index = checkpoint.index;
                        self_clone.sign_and_submit_checkpoint(checkpoint).await?;
                        tracing::info!(
                            index = checkpoint_index,
                            elapsed=?start.elapsed(),
                            "Signed and submitted checkpoint",
                        );
                        Ok(())
                    })
                })
            });

            join_all(futures).await;

            tracing::info!(
                elapsed=?start.elapsed(),
                chunk_len,
                remaining_checkpoints = checkpoints.len(),
                "Signed and submitted checkpoint chunk",
            );

            // If it's the first chunk, update the latest index
            if first_chunk {
                call_and_retry_indefinitely(|| {
                    let self_clone = self.clone();
                    Box::pin(async move {
                        let start = Instant::now();
                        self_clone
                            .checkpoint_syncer
                            .update_latest_index(last_checkpoint_index)
                            .await?;
                        tracing::trace!(
                            elapsed=?start.elapsed(),
                            "Updated latest index",
                        );
                        Ok(())
                    })
                })
                .await;
                first_chunk = false;
            }
        }
    }
}

/// Returns whether the tree exceeds the checkpoint.
fn tree_exceeds_checkpoint(checkpoint: &Checkpoint, tree: &IncrementalMerkle) -> bool {
    // tree.index() will panic if the tree is empty, so we use tree.count() instead
    // and convert the correctness_checkpoint.index to a count by adding 1.
    checkpoint.index.saturating_add(1) < tree.count() as u32
}

#[derive(Clone)]
pub(crate) struct ValidatorSubmitterMetrics {
    latest_checkpoint_observed: IntGauge,
    latest_checkpoint_processed: IntGauge,
    backfill_complete: IntGauge,
    reached_initial_consistency: IntGauge,
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
            backfill_complete: metrics.backfill_complete().with_label_values(&[chain_name]),
            reached_initial_consistency: metrics
                .reached_initial_consistency()
                .with_label_values(&[chain_name]),
        }
    }

    fn set_latest_checkpoint_observed(&self, checkpoint: &CheckpointAtBlock) {
        let prev_checkpoint_index = self.latest_checkpoint_observed.get();

        if prev_checkpoint_index > checkpoint.index as i64 {
            tracing::warn!(
                ?checkpoint,
                prev_checkpoint_index,
                checkpoint_index=checkpoint.index, "Observed a checkpoint with index that is lower than previous checkpoint. Did a reorg occur?");
        }
        self.latest_checkpoint_observed.set(checkpoint.index as i64);
    }
}

#[cfg(test)]
mod tests;
