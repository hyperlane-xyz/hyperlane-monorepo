use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::{Duration, Instant};
use std::vec;

use futures::future::join_all;
use prometheus::IntGauge;
use tokio::{
    sync::{watch, Notify},
    time::sleep,
};
use tracing::{debug, error, info, warn};

use hyperlane_base::db::HyperlaneDb;
use hyperlane_base::{CheckpointSyncer, CoreMetrics};
use hyperlane_core::rpc_clients::call_and_retry_indefinitely;
use hyperlane_core::{
    accumulator::incremental::{IncrementalMerkle, MerkleTreeSnapshot},
    Checkpoint, CheckpointAtBlock, CheckpointWithMessageId, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneSignerExt, IncrementalMerkleAtBlock, H256,
};
use hyperlane_core::{
    ChainResult, HyperlaneSigner, MerkleTreeHook, ReorgEvent, ReorgPeriod, SignedType,
};
use hyperlane_ethereum::{Signers, SingletonSignerHandle};

use crate::lightweight::{required_agreement, LightweightCheckpointReader};
use crate::merkle_tree_hook_sync::MerkleTreeRpcRecovery;
use crate::reorg_reporter::ReorgReporter;
use crate::server::ValidatorReadiness;

const LIGHTWEIGHT_SAMPLE_REFRESH_INTERVAL: Duration = Duration::from_secs(30);

const REORG_STATUS_WRITE_TIMEOUT: Duration = Duration::from_secs(20);

const CHECKPOINT_SUBMISSION_CHUNK_INTERVAL: Duration = Duration::from_millis(100);

const MERKLE_REPLAY_YIELD_INTERVAL: usize = 256;

// All queued checkpoints share the hook address and domain of the final verified
// checkpoint. Retain only the fields that vary until that correctness gate passes.
struct QueuedCheckpoint {
    root: H256,
    index: u32,
    message_id: H256,
}

impl QueuedCheckpoint {
    fn into_checkpoint(self, verified_checkpoint: Checkpoint) -> CheckpointWithMessageId {
        CheckpointWithMessageId {
            checkpoint: Checkpoint {
                root: self.root,
                index: self.index,
                ..verified_checkpoint
            },
            message_id: self.message_id,
        }
    }
}

// Keep frontiers only at sampled endpoint indices. Historical publication replays
// the DB separately, so live verification must not retain a per-message queue.
struct LightweightTree {
    committed: IncrementalMerkle,
    accumulated: IncrementalMerkle,
    sampled: BTreeMap<u32, (IncrementalMerkle, H256)>,
}

impl LightweightTree {
    fn new(tree: IncrementalMerkle) -> Self {
        Self {
            accumulated: tree.clone(),
            committed: tree,
            sampled: BTreeMap::new(),
        }
    }

    fn prepare_samples(&mut self, indices: &BTreeSet<u32>) {
        self.sampled.retain(|index, _| indices.contains(index));
        // A refreshed endpoint can retreat to an index we did not capture.
        // Reconstruct it from the last committed frontier, using cached DB leaves.
        if indices.iter().any(|index| {
            usize::try_from(*index).expect("leaf index fits in usize") >= self.committed.count()
                && usize::try_from(*index).expect("leaf index fits in usize")
                    < self.accumulated.count()
                && !self.sampled.contains_key(index)
        }) {
            self.accumulated = self.committed.clone();
            self.sampled.clear();
        }
    }

    fn root_at(&self, index: u32) -> Option<H256> {
        if self.committed.count() > 0 && index == self.committed.index() {
            return Some(self.committed.root());
        }
        self.sampled.get(&index).map(|(tree, _)| tree.root())
    }

    fn ingest(&mut self, message_id: H256, capture: bool) {
        self.accumulated.ingest(message_id);
        if capture {
            self.sampled.insert(
                self.accumulated.index(),
                (self.accumulated.clone(), message_id),
            );
        }
    }

    fn commit(&mut self, index: u32) -> Option<QueuedCheckpoint> {
        if self.committed.count() > 0 && self.committed.index() == index {
            return None;
        }
        let (tree, message_id) = self
            .sampled
            .remove(&index)
            .expect("verified sampled frontier");
        let latest = QueuedCheckpoint {
            root: tree.root(),
            index,
            message_id,
        };
        self.committed = tree;
        self.sampled.retain(|sample_index, _| *sample_index > index);
        Some(latest)
    }
}

enum LightweightBatch {
    WaitingForInsertions,
    WaitingForRpc,
    Verified {
        checkpoint: CheckpointAtBlock,
        latest: Option<QueuedCheckpoint>,
    },
}

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
    reorg_reporter: Option<Arc<dyn ReorgReporter>>,
    readiness: Arc<ValidatorReadiness>,
    checkpoint_wake: Option<Arc<Notify>>,
    rpc_recovery: Option<MerkleTreeRpcRecovery>,
    historical_publication: bool,
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
        reorg_reporter: Option<Arc<dyn ReorgReporter>>,
        readiness: Arc<ValidatorReadiness>,
    ) -> Self {
        assert!(
            max_sign_concurrency > 0,
            "maxSignConcurrency must be greater than zero"
        );
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
            readiness,
            checkpoint_wake: None,
            rpc_recovery: None,
            historical_publication: false,
        }
    }

    pub(crate) fn with_checkpoint_wake(mut self, checkpoint_wake: Option<Arc<Notify>>) -> Self {
        self.checkpoint_wake = checkpoint_wake;
        self
    }

    pub(crate) fn with_rpc_recovery(mut self, recovery: MerkleTreeRpcRecovery) -> Self {
        self.rpc_recovery = Some(recovery);
        self
    }

    async fn wait_for_checkpoint_check(&self) {
        if let Some(checkpoint_wake) = &self.checkpoint_wake {
            tokio::select! {
                _ = sleep(self.interval) => {}
                _ = checkpoint_wake.notified() => {}
            }
        } else {
            sleep(self.interval).await;
        }
    }

    fn checkpoint(&self, root: H256, index: u32) -> Checkpoint {
        Checkpoint {
            merkle_tree_hook_address: self.merkle_tree_hook.address(),
            mailbox_domain: self.merkle_tree_hook.domain().id(),
            root,
            index,
        }
    }

    pub(crate) fn checkpoint_at_block(&self, tree: &IncrementalMerkleAtBlock) -> CheckpointAtBlock {
        let checkpoint = self.checkpoint(tree.tree.root(), tree.tree.index());

        CheckpointAtBlock {
            checkpoint,
            block_height: tree.block_height,
        }
    }

    /// Submits signed checkpoints from index 0 until the target checkpoint (inclusive).
    /// Runs idly forever once the target checkpoint is reached to avoid exiting the task.
    pub(crate) async fn backfill_checkpoint_submitter(
        mut self,
        target_checkpoint: CheckpointAtBlock,
        mut tree: IncrementalMerkle,
    ) {
        self.start_historical_publication(&tree);
        self.submit_checkpoints_until_correctness_checkpoint(&mut tree, &target_checkpoint)
            .await;

        match MerkleTreeSnapshot::capture(&tree) {
            Ok(snapshot) => {
                if let Err(err) = self
                    .checkpoint_syncer
                    .write_merkle_snapshot(&snapshot)
                    .await
                {
                    warn!(
                        ?err,
                        index = snapshot.index,
                        "Failed to write merkle snapshot"
                    );
                }
            }
            Err(err) => {
                warn!(?err, "Failed to capture merkle snapshot");
            }
        }

        info!(
            ?target_checkpoint,
            "Backfill checkpoint submitter successfully reached target checkpoint"
        );

        // Set that backfill is completed in metrics
        self.metrics.backfill_complete.set(1);
    }

    /// Authenticate the replay frontier before starting websocket indexing.
    pub(crate) async fn restore_lightweight_tree(&self) -> IncrementalMerkle {
        let restored = self.restored_snapshot_tree(u32::MAX).await;
        if restored.is_some() {
            self.readiness.mark_operation_ready("lightweight_snapshot");
            self.metrics.backfill_complete.set(1);
        }
        restored.unwrap_or_default()
    }

    /// Authenticate websocket insertions against two thirds of configured endpoints. Historical
    /// publication cannot block new verified messages.
    pub(crate) async fn lightweight_checkpoint_submitter(
        self,
        reader: Arc<LightweightCheckpointReader>,
        restored_tree: IncrementalMerkle,
    ) {
        let started = Instant::now();
        let mut initial_verification_complete = false;
        self.record_tree_progress(&restored_tree).await;
        let (history_target, history_targets) = watch::channel(None);
        let mut history = tokio::task::JoinSet::new();
        history.spawn(
            self.clone()
                .lightweight_history_submitter(restored_tree.clone(), history_targets),
        );
        let mut tree = LightweightTree::new(restored_tree);
        let mut samples: Option<Vec<Option<CheckpointAtBlock>>> = None;
        let mut sampled_at = tokio::time::Instant::now();
        let mut next_rpc_attempt = sampled_at;
        loop {
            // The single worker is cancelled when the signing task exits.
            if let Some(result) = history.try_join_next() {
                result.expect("Historical checkpoint publication failed");
                panic!("Historical checkpoint publication stopped unexpectedly");
            }
            let next_index =
                u32::try_from(tree.committed.count()).expect("Merkle leaf count fits in u32");
            if samples.is_none()
                && self
                    .db
                    .retrieve_merkle_tree_insertion_by_leaf_index(&next_index)
                    .expect("Failed to fetch merkle tree insertion")
                    .is_none()
            {
                self.wait_for_checkpoint_check().await;
                continue;
            }
            if samples.is_none() || sampled_at.elapsed() >= LIGHTWEIGHT_SAMPLE_REFRESH_INTERVAL {
                // Notifications may wake insertion processing immediately, but may
                // never accelerate checkpoint reads, including after RPC errors.
                tokio::time::sleep_until(next_rpc_attempt).await;
                let result = reader.checkpoints(&self.reorg_period).await;
                next_rpc_attempt = tokio::time::Instant::now()
                    .checked_add(self.interval)
                    .expect("checkpoint interval fits in Instant");
                match result {
                    Ok(checkpoints) => {
                        self.readiness
                            .mark_operation_ready("lightweight_checkpoint_reads");
                        if let Some(previous) = &mut samples {
                            // Preserve valid or not-yet-replayed targets rather than
                            // chasing the moving tip. Never retain a known conflict
                            // when a later checkpoint could restore agreement.
                            for (old, new) in previous.iter_mut().zip(checkpoints) {
                                let preserve = match (&*old, &new) {
                                    (Some(old), Some(new)) if new.index > old.index => {
                                        !tree_exceeds_checkpoint(old, &tree.committed)
                                            && tree.root_at(old.index).is_none_or(|root| {
                                                self.checkpoint(root, old.index) == old.checkpoint
                                            })
                                    }
                                    _ => false,
                                };
                                if !preserve {
                                    *old = new;
                                }
                            }
                        } else {
                            samples = Some(checkpoints);
                        }
                        sampled_at = tokio::time::Instant::now();
                    }
                    Err(err) => {
                        self.readiness
                            .mark_operation_blocked("lightweight_checkpoint_reads");
                        warn!(
                            ?err,
                            "Waiting for two-thirds lightweight checkpoint responses"
                        );
                        continue;
                    }
                }
            }
            let batch = self
                .verify_lightweight_batch(&mut tree, samples.as_ref().expect("checkpoint samples"))
                .await;
            match batch {
                LightweightBatch::WaitingForInsertions => {}
                LightweightBatch::WaitingForRpc => samples = None,
                LightweightBatch::Verified { checkpoint, latest } => {
                    if !initial_verification_complete {
                        info!(
                            domain = checkpoint.mailbox_domain,
                            verified_index = checkpoint.index,
                            root = ?checkpoint.root,
                            rpc_endpoints = samples.as_ref().expect("verified checkpoint samples").len(),
                            elapsed = ?started.elapsed(),
                            "Initial lightweight backfill verified: local roots match a two-thirds RPC majority"
                        );
                        initial_verification_complete = true;
                    }
                    samples = None;
                    if let Some(latest) = latest {
                        // Older indices are reconstructed by one worker from the DB.
                        self.sign_and_submit_checkpoints(std::iter::once(
                            latest.into_checkpoint(checkpoint.checkpoint),
                        ))
                        .await;
                        history_target
                            .send(Some(checkpoint.clone()))
                            .expect("Historical checkpoint worker is running");
                    }
                    self.metrics
                        .latest_checkpoint_processed
                        .set(i64::from(checkpoint.index));
                    self.metrics.reached_initial_consistency.set(1);
                }
            }
            self.wait_for_checkpoint_check().await;
        }
    }

    /// Coalesce newer targets while retrying old uploads. There is one worker
    /// and one pending target, regardless of how long checkpoint storage stalls.
    async fn lightweight_history_submitter(
        mut self,
        mut tree: IncrementalMerkle,
        mut targets: watch::Receiver<Option<CheckpointAtBlock>>,
    ) {
        self.start_historical_publication(&tree);
        let started = Instant::now();
        let mut initial_publication_complete = false;
        while targets.changed().await.is_ok() {
            let target = targets
                .borrow_and_update()
                .clone()
                .expect("verified target");
            if !initial_publication_complete {
                info!(
                    domain = target.mailbox_domain,
                    reconstructed_leaf_count = tree.count(),
                    target_leaf_count = u64::from(target.index).saturating_add(1),
                    "Reconstructing historical checkpoints from cached insertions before publication"
                );
            }
            let mut queue = self.verified_checkpoints(&mut tree, &target).await;
            // The live submitter published this target before notifying us.
            if queue.pop().is_some() {
                self.metrics.backfill_merkle_tree_leaf_count.inc();
            }
            self.submit_checkpoints(
                queue
                    .into_iter()
                    .map(|queued| queued.into_checkpoint(target.checkpoint)),
                false,
            )
            .await;
            // Only this worker writes snapshots, after every covered checkpoint
            // is durable. Never snapshot the main loop's newer committed tree.
            self.persist_lightweight_snapshot(&tree).await;
            self.metrics.backfill_complete.set(1);
            if !initial_publication_complete {
                info!(
                    domain = target.mailbox_domain,
                    through_index = target.index,
                    root = ?tree.root(),
                    elapsed = ?started.elapsed(),
                    "Initial lightweight historical checkpoint publication complete"
                );
                initial_publication_complete = true;
            }
        }
    }

    async fn persist_lightweight_snapshot(&self, tree: &IncrementalMerkle) {
        let snapshot = MerkleTreeSnapshot::capture(tree).expect("verified nonempty tree");
        match tokio::time::timeout(
            REORG_STATUS_WRITE_TIMEOUT,
            self.checkpoint_syncer.write_merkle_snapshot(&snapshot),
        )
        .await
        {
            Ok(Ok(())) => {}
            Ok(Err(err)) => warn!(?err, "Failed to persist lightweight snapshot"),
            Err(_) => warn!("Timed out persisting lightweight snapshot"),
        }
    }

    async fn verify_lightweight_batch(
        &self,
        tree: &mut LightweightTree,
        checkpoints: &[Option<CheckpointAtBlock>],
    ) -> LightweightBatch {
        self.record_tree_progress(&tree.accumulated).await;
        let required = required_agreement(checkpoints.len());
        let indices: BTreeSet<_> = checkpoints
            .iter()
            .flatten()
            .map(|checkpoint| checkpoint.index)
            .collect();
        tree.prepare_samples(&indices);
        let Some(max_index) = indices.last().copied() else {
            self.readiness
                .mark_operation_blocked("lightweight_checkpoint_progress");
            return LightweightBatch::WaitingForRpc;
        };
        while tree.accumulated.count() <= max_index as usize {
            let index =
                u32::try_from(tree.accumulated.count()).expect("Merkle leaf count fits in u32");
            let Some(insertion) = self
                .db
                .retrieve_merkle_tree_insertion_by_leaf_index(&index)
                .expect("Failed to fetch merkle tree insertion")
            else {
                break;
            };
            tree.ingest(insertion.message_id(), indices.contains(&index));
            self.record_tree_progress(&tree.accumulated).await;
        }
        let mut matching = Vec::new();
        let mut missing: usize = 0;
        for (endpoint_index, observed) in checkpoints.iter().enumerate() {
            let Some(observed) = observed else { continue };
            if tree_exceeds_checkpoint(observed, &tree.committed) {
                continue;
            }
            if let Some(root) = tree.root_at(observed.index) {
                if self.checkpoint(root, observed.index) == observed.checkpoint {
                    matching.push(observed);
                } else {
                    warn!(
                        endpoint_index,
                        index = observed.index,
                        "Lightweight RPC checkpoint does not match local history"
                    );
                }
            } else {
                missing = missing.saturating_add(1);
            }
        }
        if matching.len() < required {
            self.readiness
                .mark_operation_blocked("lightweight_checkpoint_progress");
            if matching.len().saturating_add(missing) >= required {
                self.readiness
                    .mark_operation_blocked("lightweight_websocket_insertions");
                return LightweightBatch::WaitingForInsertions;
            }
            self.readiness
                .mark_operation_ready("lightweight_websocket_insertions");
            warn!(
                matching = matching.len(),
                required, "Waiting for two-thirds RPC agreement with local history"
            );
            return LightweightBatch::WaitingForRpc;
        }
        // A matching later root authenticates every earlier insertion. The
        // required-th highest matching index is therefore the signing boundary.
        matching.sort_unstable_by_key(|checkpoint| std::cmp::Reverse(checkpoint.index));
        let target = matching[required.saturating_sub(1)];
        self.metrics.set_latest_checkpoint_observed(target);
        self.readiness
            .mark_operation_ready("lightweight_websocket_insertions");
        self.readiness
            .mark_operation_ready("lightweight_checkpoint_progress");
        let latest = tree.commit(target.index);
        LightweightBatch::Verified {
            checkpoint: target.clone(),
            latest,
        }
    }

    /// Submits signed checkpoints indefinitely, starting from the `tree`.
    pub(crate) async fn checkpoint_submitter(mut self, mut tree: IncrementalMerkle) {
        self.record_tree_progress(&tree).await;
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
                self.wait_for_checkpoint_check().await;
                continue;
            }
            self.submit_checkpoints_until_correctness_checkpoint(&mut tree, &latest_checkpoint)
                .await;
            if let Some(recovery) = &mut self.rpc_recovery {
                if let Some(height) = latest_checkpoint.block_height {
                    recovery.from_block = Some(height);
                }
            }

            self.metrics
                .latest_checkpoint_processed
                .set(latest_checkpoint.index as i64);

            // Set that initial consistency has been reached on first loop run. Subsequent runs are idempotent.
            self.metrics.reached_initial_consistency.set(1);

            self.wait_for_checkpoint_check().await;
        }
    }

    /// Submits signed checkpoints relating to the given tree until the correctness checkpoint (inclusive).
    /// Only submits the signed checkpoints once the correctness checkpoint is reached.
    async fn submit_checkpoints_until_correctness_checkpoint(
        &self,
        tree: &mut IncrementalMerkle,
        correctness_checkpoint: &CheckpointAtBlock,
    ) {
        let queue = self
            .verified_checkpoints(tree, correctness_checkpoint)
            .await;
        self.sign_and_submit_checkpoints(
            queue
                .into_iter()
                .map(|queued| queued.into_checkpoint(correctness_checkpoint.checkpoint)),
        )
        .await;
    }

    /// Reconstruct a complete prefix and verify it before exposing checkpoints to signing.
    async fn verified_checkpoints(
        &self,
        tree: &mut IncrementalMerkle,
        correctness_checkpoint: &CheckpointAtBlock,
    ) -> Vec<QueuedCheckpoint> {
        self.record_tree_progress(tree).await;
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
        // Retain the last verified tree so untrusted websocket leaves can be
        // replaced by RPC fallback without advancing the signing boundary.
        let verified_tree = self.rpc_recovery.as_ref().map(|_| tree.clone());
        let mut blocked_insertion_operation: Option<String> = None;

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
                Some(insertion) => {
                    if let Some(operation) = blocked_insertion_operation.take() {
                        self.readiness.mark_operation_ready(&operation);
                    }
                    insertion
                }
                None => {
                    if blocked_insertion_operation.is_none() {
                        let operation = format!("merkle_tree_insertion[{}]", tree.count());
                        let snapshot = self.readiness.mark_operation_blocked(&operation);
                        warn!(
                            operation,
                            consecutive_failures = snapshot.consecutive_failures,
                            failure_duration_ms = snapshot.failure_duration_ms,
                            signing_blocked = snapshot.signing_blocked,
                            "Validator checkpoint production is waiting for an indexed merkle tree insertion"
                        );
                        blocked_insertion_operation = Some(operation);
                    }
                    // If we haven't yet indexed the next merkle tree insertion but know that
                    // it will soon exist (because we know the correctness checkpoint), wait a bit and
                    // try again.
                    sleep(Duration::from_millis(100)).await;
                    continue;
                }
            };

            let message_id = insertion.message_id();
            tree.ingest(message_id);

            checkpoint_queue.push(QueuedCheckpoint {
                root: tree.root(),
                index: tree.index(),
                message_id,
            });
            self.record_tree_progress(tree).await;
        }

        if let (Some(recovery), Some(verified_tree)) = (&self.rpc_recovery, verified_tree) {
            if !checkpoint_queue.is_empty()
                && self.checkpoint(tree.root(), tree.index()) != correctness_checkpoint.checkpoint
            {
                let operation = format!(
                    "websocket_checkpoint_recovery[{}]",
                    correctness_checkpoint.index
                );
                self.readiness.mark_operation_blocked(&operation);
                warn!(
                    first_sequence = verified_tree.count(),
                    last_sequence = correctness_checkpoint.index,
                    "WebSocket batch failed root verification; falling back to RPC indexing"
                );
                let first_sequence = u32::try_from(verified_tree.count())
                    .expect("Merkle tree count fits in u32 before the target checkpoint");
                let leaves = loop {
                    match recovery
                        .fetch_insertions(first_sequence, correctness_checkpoint)
                        .await
                    {
                        Ok(leaves) => break leaves,
                        Err(err) => {
                            warn!(
                                ?err,
                                "RPC fallback batch recovery failed; signing remains blocked"
                            );
                            sleep(self.interval).await;
                        }
                    }
                };
                *tree = verified_tree;
                self.record_tree_progress(tree).await;
                checkpoint_queue.clear();
                for (insertion, _) in &leaves {
                    let message_id = insertion.inner().message_id();
                    tree.ingest(message_id);
                    checkpoint_queue.push(QueuedCheckpoint {
                        root: tree.root(),
                        index: tree.index(),
                        message_id,
                    });
                    self.record_tree_progress(tree).await;
                }
                // Only repair durable rows after the recovered batch passes the
                // same checkpoint gate. Persistent disagreement still halts below.
                if self.checkpoint(tree.root(), tree.index()) == correctness_checkpoint.checkpoint {
                    loop {
                        match recovery.store_verified_insertions(&leaves) {
                            Ok(()) => break,
                            Err(err) => {
                                warn!(?err, "Persisting verified RPC recovery failed; signing remains blocked");
                                sleep(self.interval).await;
                            }
                        }
                    }
                    self.readiness.mark_operation_ready(&operation);
                }
            }
        }

        let root = checkpoint_queue
            .last()
            .map(|checkpoint| checkpoint.root)
            .unwrap_or_else(|| tree.root());

        // At this point we know that correctness_checkpoint.index == tree.index().
        assert_eq!(
            correctness_checkpoint.index,
            tree.index(),
            "correctness checkpoint index {} != tree index {}",
            correctness_checkpoint.index,
            tree.index(),
        );

        let checkpoint = self.checkpoint(root, tree.index());

        self.verify_checkpoint(
            checkpoint,
            correctness_checkpoint,
            self.reorg_reporter.is_some(),
        )
        .await;

        if !checkpoint_queue.is_empty() {
            info!(
                ?root,
                queue_length = checkpoint_queue.len(),
                elapsed = ?start.elapsed(),
                "Checkpoint submitter reached correctness checkpoint"
            );
        }
        checkpoint_queue
    }

    fn start_historical_publication(&mut self, tree: &IncrementalMerkle) {
        self.historical_publication = true;
        // Restored snapshots cover checkpoints already published by this worker.
        self.metrics
            .backfill_merkle_tree_leaf_count
            .set(i64::try_from(tree.count()).expect("Merkle leaf count fits in i64"));
        self.metrics
            .historical_reconstruction_leaf_count
            .set(i64::try_from(tree.count()).expect("Merkle leaf count fits in i64"));
    }

    async fn record_tree_progress(&self, tree: &IncrementalMerkle) {
        let metric = if self.historical_publication {
            &self.metrics.historical_reconstruction_leaf_count
        } else {
            &self.metrics.merkle_tree_leaf_count
        };
        metric.set(i64::try_from(tree.count()).expect("Merkle leaf count fits in i64"));
        yield_during_merkle_replay(tree.count()).await;
    }

    async fn verify_checkpoint(
        &self,
        checkpoint: Checkpoint,
        correctness_checkpoint: &CheckpointAtBlock,
        report_rpc: bool,
    ) {
        // If the tree's checkpoint doesn't match the correctness checkpoint, something went wrong
        // and we bail loudly.
        if checkpoint != correctness_checkpoint.checkpoint {
            let reorg_event = ReorgEvent::new(
                checkpoint.root,
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

            // Lightweight mode uses its own endpoint verification. Extra
            // diagnostic RPC reads can retry forever or ignore historical heights.
            if report_rpc {
                if let Some(height) = correctness_checkpoint.block_height {
                    self.reorg_reporter
                        .as_ref()
                        .expect("normal-mode reorg reporter")
                        .report_at_block(height)
                        .await;
                } else {
                    info!("Blockchain does not support block height, reporting with reorg period");
                    self.reorg_reporter
                        .as_ref()
                        .expect("normal-mode reorg reporter")
                        .report_with_reorg_period(&self.reorg_period)
                        .await;
                }
            }

            let mut panic_message = "Incorrect tree root. Most likely a reorg has occurred. Please reach out for help, this is a potentially serious error impacting signed messages. Do NOT forcefully resume operation of this validator. Keep it crashlooping or shut down until you receive support.".to_owned();
            let write_status = self.checkpoint_syncer.write_reorg_status(&reorg_event);
            let result = if report_rpc {
                write_status.await
            } else {
                match tokio::time::timeout(REORG_STATUS_WRITE_TIMEOUT, write_status).await {
                    Ok(result) => result,
                    Err(_) => Err(eyre::eyre!("Timed out writing lightweight reorg status")),
                }
            };
            if let Err(e) = result {
                panic_message.push_str(&format!(
                    " Reorg troubleshooting details couldn't be written to checkpoint storage: {e}"
                ));
            }
            panic!("{panic_message}");
        }
    }

    /// Restores a snapshot after validating it against the signed checkpoint.
    pub(crate) async fn restored_snapshot_tree(
        &self,
        target_index: u32,
    ) -> Option<IncrementalMerkle> {
        let snapshot = match self.checkpoint_syncer.read_merkle_snapshot().await {
            Ok(Some(snapshot)) => snapshot,
            Ok(None) => return None,
            Err(err) => {
                warn!(?err, "Failed to read merkle snapshot, rebuilding tree");
                return None;
            }
        };
        if snapshot.index > target_index {
            debug!(
                snapshot_index = snapshot.index,
                target_index, "Snapshot is ahead of target, rebuilding tree"
            );
            return None;
        }
        let tree = match snapshot.restore() {
            Ok(tree) => tree,
            Err(err) => {
                warn!(?err, "Stored merkle snapshot is corrupt, rebuilding tree");
                return None;
            }
        };
        match self
            .checkpoint_syncer
            .fetch_checkpoint(snapshot.index)
            .await
        {
            Ok(Some(existing)) => match existing.recover() {
                Ok(signer)
                    if signer == self.signer.eth_address()
                        && existing.value.checkpoint
                            == self.checkpoint(tree.root(), tree.index()) =>
                {
                    info!(
                        snapshot_index = snapshot.index,
                        "Restored merkle tree from validated snapshot"
                    );
                    Some(tree)
                }
                _ => {
                    warn!(
                        snapshot_index = snapshot.index,
                        "Snapshot checkpoint mismatch, rebuilding tree"
                    );
                    None
                }
            },
            Ok(None) => {
                warn!(
                    snapshot_index = snapshot.index,
                    "Snapshot checkpoint missing, rebuilding tree"
                );
                None
            }
            Err(err) => {
                warn!(
                    ?err,
                    snapshot_index = snapshot.index,
                    "Snapshot checkpoint fetch failed, rebuilding tree"
                );
                None
            }
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
    ) -> ChainResult<bool> {
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
                return Ok(false);
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

        Ok(true)
    }

    /// Publishes availability only after the highest checkpoint itself is durable.
    async fn publish_latest_checkpoint_index(self: &Arc<Self>, index: u32) {
        call_and_retry_indefinitely(|| {
            let self_clone = self.clone();
            Box::pin(async move {
                let start = Instant::now();
                let result = self_clone
                    .checkpoint_syncer
                    .update_latest_index(index)
                    .await;
                match result {
                    Ok(()) => self_clone
                        .readiness
                        .mark_operation_ready("checkpoint_latest_index"),
                    Err(error) => {
                        let snapshot = self_clone
                            .readiness
                            .mark_operation_blocked("checkpoint_latest_index");
                        warn!(
                            operation = "checkpoint_latest_index",
                            consecutive_failures = snapshot.consecutive_failures,
                            failure_duration_ms = snapshot.failure_duration_ms,
                            signing_blocked = snapshot.signing_blocked,
                            "Validator latest checkpoint index update is blocked"
                        );
                        return Err(error.into());
                    }
                }
                tracing::trace!(
                    elapsed=?start.elapsed(),
                    "Updated latest index",
                );
                Ok(())
            })
        })
        .await;
    }

    /// Signs and submits any previously unsubmitted checkpoints.
    async fn sign_and_submit_checkpoints<I>(&self, checkpoints: I)
    where
        I: IntoIterator<Item = CheckpointWithMessageId>,
        I::IntoIter: DoubleEndedIterator + ExactSizeIterator,
    {
        self.submit_checkpoints(checkpoints, true).await;
    }

    /// Historical publication must not race the live writer's latest-index update.
    async fn submit_checkpoints<I>(&self, checkpoints: I, publish_latest: bool)
    where
        I: IntoIterator<Item = CheckpointWithMessageId>,
        I::IntoIter: DoubleEndedIterator + ExactSizeIterator,
    {
        // Reconstruct compact queue entries only as their signing chunk is consumed.
        // The input is ordered by index, so reversing starts with the highest index.
        let mut checkpoints = checkpoints.into_iter().rev().peekable();
        let mut latest_index_to_publish = match checkpoints.peek() {
            Some(c) => publish_latest.then_some(c.index),
            None => return,
        };

        let arc_self = Arc::new(self.clone());

        while checkpoints.len() > 0 {
            let start = Instant::now();

            // Take a chunk of checkpoints, starting with the highest index.
            // This speeds up processing historic checkpoints (those before the validator is spun up),
            // since those are the most likely to make messages become processable.
            // A side effect is that new checkpoints will also be submitted in reverse order.

            // Keep bounded chunks so a storage/signing burst is paced before the next chunk.
            let chunk_len = checkpoints.len().min(self.max_sign_concurrency);
            let chunk = checkpoints.by_ref().take(self.max_sign_concurrency);
            let futures = chunk.map(|checkpoint| {
                let self_clone = arc_self.clone();
                // The first popped checkpoint alone owns publication, even if a caller
                // supplied the same maximum index more than once.
                let latest_index = latest_index_to_publish.take();
                async move {
                    let operation = format!("checkpoint_submission[{}]", checkpoint.index);
                    let wrote_checkpoint = call_and_retry_indefinitely(|| {
                        let self_clone = self_clone.clone();
                        let operation = operation.clone();
                        Box::pin(async move {
                            let start = Instant::now();
                            let checkpoint_index = checkpoint.index;
                            let result = self_clone.sign_and_submit_checkpoint(checkpoint).await;
                            let wrote_checkpoint = match result {
                                Ok(wrote_checkpoint) => {
                                    self_clone.readiness.mark_operation_ready(&operation);
                                    wrote_checkpoint
                                }
                                Err(error) => {
                                    let snapshot =
                                        self_clone.readiness.mark_operation_blocked(&operation);
                                    warn!(
                                        operation,
                                        consecutive_failures = snapshot.consecutive_failures,
                                        failure_duration_ms = snapshot.failure_duration_ms,
                                        signing_blocked = snapshot.signing_blocked,
                                        "Validator checkpoint submission is blocked"
                                    );
                                    return Err(error);
                                }
                            };
                            tracing::trace!(
                                index = checkpoint_index,
                                wrote_checkpoint,
                                elapsed=?start.elapsed(),
                                "Processed checkpoint",
                            );
                            Ok(wrote_checkpoint)
                        })
                    })
                    .await;
                    // Count each checkpoint once, after a successful write or confirmation
                    // that the matching checkpoint already exists, never on failed attempts.
                    if self_clone.historical_publication {
                        self_clone.metrics.backfill_merkle_tree_leaf_count.inc();
                    }
                    // Lower checkpoints may still be retrying. The latest index is an upper
                    // bound, not a claim that every historical checkpoint has been uploaded.
                    if let Some(index) = latest_index {
                        self_clone.publish_latest_checkpoint_index(index).await;
                    }
                    wrote_checkpoint
                }
            });

            let wrote_checkpoint = join_all(futures).await.into_iter().any(|wrote| wrote);

            if wrote_checkpoint {
                tracing::info!(
                    elapsed=?start.elapsed(),
                    chunk_len,
                    remaining_checkpoints = checkpoints.len(),
                    "Signed and submitted checkpoint chunk",
                );
            } else {
                tracing::trace!(
                    elapsed=?start.elapsed(),
                    chunk_len,
                    remaining_checkpoints = checkpoints.len(),
                    "Checkpoint chunk already existed",
                );
            }

            // Pace storage/signing bursts between chunks without delaying the latest-index
            // update, throttling all-existing backfills, or adding a final-chunk tail.
            if wrote_checkpoint && checkpoints.len() > 0 {
                sleep(CHECKPOINT_SUBMISSION_CHUNK_INTERVAL).await;
            }
        }
    }
}

// Reconstruction is CPU-bound and reads RocksDB synchronously. Yield so socket
// heartbeats and metrics scrapes can run while millions of cached leaves replay.
async fn yield_during_merkle_replay(count: usize) {
    if count > 0 && count.is_multiple_of(MERKLE_REPLAY_YIELD_INTERVAL) {
        tokio::task::yield_now().await;
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
    merkle_tree_leaf_count: IntGauge,
    historical_reconstruction_leaf_count: IntGauge,
    backfill_merkle_tree_leaf_count: IntGauge,
    latest_checkpoint_observed: IntGauge,
    latest_checkpoint_processed: IntGauge,
    backfill_complete: IntGauge,
    reached_initial_consistency: IntGauge,
}

impl ValidatorSubmitterMetrics {
    pub fn new(metrics: &CoreMetrics, mailbox_chain: &HyperlaneDomain) -> Self {
        let chain_name = mailbox_chain.name();
        Self {
            merkle_tree_leaf_count: metrics
                .validator_merkle_tree_leaf_count()
                .with_label_values(&[chain_name, "verification"]),
            historical_reconstruction_leaf_count: metrics
                .validator_merkle_tree_leaf_count()
                .with_label_values(&[chain_name, "historical_reconstruction"]),
            backfill_merkle_tree_leaf_count: metrics
                .validator_merkle_tree_leaf_count()
                .with_label_values(&[chain_name, "historical_publication"]),
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
