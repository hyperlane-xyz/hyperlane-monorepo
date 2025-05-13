use std::sync::Arc;
use std::time::{Duration, Instant};
use std::vec;

use futures::future::join_all;
use prometheus::IntGauge;
use tokio::time::sleep;
use tracing::{debug, error, info};

use hyperlane_base::db::HyperlaneDb;
use hyperlane_base::{CheckpointSyncer, CoreMetrics};
use hyperlane_core::rpc_clients::call_and_retry_indefinitely;
use hyperlane_core::{
    accumulator::incremental::IncrementalMerkle, Checkpoint, CheckpointWithMessageId,
    HyperlaneChain, HyperlaneContract, HyperlaneDomain, HyperlaneSignerExt,
};
use hyperlane_core::{ChainResult, MerkleTreeHook, ReorgEvent, ReorgPeriod, SignedType};
use hyperlane_ethereum::{Signers, SingletonSignerHandle};

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
        correctness_checkpoint: &Checkpoint,
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
            if let Some(insertion) = self
                .db
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
                "Incorrect tree root, something went wrong"
            );

            let mut panic_message = "Incorrect tree root, something went wrong.".to_owned();
            if let Err(e) = self
                .checkpoint_syncer
                .write_reorg_status(&reorg_event)
                .await
            {
                panic_message.push_str(&format!(
                    " Reorg troubleshooting details couldn't be written to checkpoint storage: {}",
                    e
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

        if existing.is_some() {
            debug!(index = checkpoint.index, "Checkpoint already submitted");
            return Ok(());
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

        debug!(index = checkpoint.index, "Signed and submitted checkpoint");

        // TODO: move these into S3 implementations
        // small sleep before signing next checkpoint to avoid rate limiting
        sleep(Duration::from_millis(100)).await;
        Ok(())
    }

    /// Signs and submits any previously unsubmitted checkpoints.
    async fn sign_and_submit_checkpoints(&self, mut checkpoints: Vec<CheckpointWithMessageId>) {
        // The checkpoints are ordered by index, so the last one is the highest index.
        let last_checkpoint_index = checkpoints[checkpoints.len() - 1].index;

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
                        self_clone.sign_and_submit_checkpoint(checkpoint).await?;
                        tracing::info!(
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
    checkpoint.index + 1 < tree.count() as u32
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
}

#[cfg(test)]
mod test {
    use super::*;
    use async_trait::async_trait;
    use eyre::Result;
    use hyperlane_base::db::{
        DbResult, HyperlaneDb, InterchainGasExpenditureData, InterchainGasPaymentData,
    };
    use hyperlane_core::{
        identifiers::UniqueIdentifier, test_utils::dummy_domain, GasPaymentKey, HyperlaneChain,
        HyperlaneContract, HyperlaneDomain, HyperlaneMessage, HyperlaneProvider,
        InterchainGasPayment, InterchainGasPaymentMeta, MerkleTreeHook, MerkleTreeInsertion,
        PendingOperationStatus, ReorgEvent, SignedAnnouncement, SignedCheckpointWithMessageId,
        H160, H256,
    };
    use prometheus::Registry;
    use std::{fmt::Debug, sync::Arc, time::Duration};
    use tokio::sync::mpsc;

    mockall::mock! {
        pub Db {
            fn provider(&self) -> Box<dyn HyperlaneProvider>;
        }

        impl Debug for Db {
            fn fmt<'a>(&self, f: &mut std::fmt::Formatter<'a>) -> std::fmt::Result;
        }

        impl HyperlaneDb for Db {
            fn retrieve_highest_seen_message_nonce(&self) -> DbResult<Option<u32>>;
            fn retrieve_message_by_nonce(&self, nonce: u32) -> DbResult<Option<HyperlaneMessage>>;
            fn retrieve_processed_by_nonce(&self, nonce: &u32) -> DbResult<Option<bool>>;
            fn domain(&self) -> &HyperlaneDomain;
            fn store_message_id_by_nonce(&self, nonce: &u32, id: &H256) -> DbResult<()>;
            fn retrieve_message_id_by_nonce(&self, nonce: &u32) -> DbResult<Option<H256>>;
            fn store_message_by_id(&self, id: &H256, message: &HyperlaneMessage) -> DbResult<()>;
            fn retrieve_message_by_id(&self, id: &H256) -> DbResult<Option<HyperlaneMessage>>;
            fn store_dispatched_block_number_by_nonce(
                &self,
                nonce: &u32,
                block_number: &u64,
            ) -> DbResult<()>;
            fn retrieve_dispatched_block_number_by_nonce(&self, nonce: &u32) -> DbResult<Option<u64>>;
            fn store_processed_by_nonce(&self, nonce: &u32, processed: &bool) -> DbResult<()>;
            fn store_processed_by_gas_payment_meta(
                &self,
                meta: &InterchainGasPaymentMeta,
                processed: &bool,
            ) -> DbResult<()>;
            fn retrieve_processed_by_gas_payment_meta(
                &self,
                meta: &InterchainGasPaymentMeta,
            ) -> DbResult<Option<bool>>;
            fn store_interchain_gas_expenditure_data_by_message_id(
                &self,
                message_id: &H256,
                data: &InterchainGasExpenditureData,
            ) -> DbResult<()>;
            fn retrieve_interchain_gas_expenditure_data_by_message_id(
                &self,
                message_id: &H256,
            ) -> DbResult<Option<InterchainGasExpenditureData>>;
            fn store_status_by_message_id(
                &self,
                message_id: &H256,
                status: &PendingOperationStatus,
            ) -> DbResult<()>;
            fn retrieve_status_by_message_id(
                &self,
                message_id: &H256,
            ) -> DbResult<Option<PendingOperationStatus>>;
            fn store_interchain_gas_payment_data_by_gas_payment_key(
                &self,
                key: &GasPaymentKey,
                data: &InterchainGasPaymentData,
            ) -> DbResult<()>;
            fn retrieve_interchain_gas_payment_data_by_gas_payment_key(
                &self,
                key: &GasPaymentKey,
            ) -> DbResult<Option<InterchainGasPaymentData>>;
            fn store_gas_payment_by_sequence(
                &self,
                sequence: &u32,
                payment: &InterchainGasPayment,
            ) -> DbResult<()>;
            fn retrieve_gas_payment_by_sequence(
                &self,
                sequence: &u32,
            ) -> DbResult<Option<InterchainGasPayment>>;
            fn store_gas_payment_block_by_sequence(
                &self,
                sequence: &u32,
                block_number: &u64,
            ) -> DbResult<()>;
            fn retrieve_gas_payment_block_by_sequence(&self, sequence: &u32) -> DbResult<Option<u64>>;
            fn store_pending_message_retry_count_by_message_id(
                &self,
                message_id: &H256,
                count: &u32,
            ) -> DbResult<()>;
            fn retrieve_pending_message_retry_count_by_message_id(
                &self,
                message_id: &H256,
            ) -> DbResult<Option<u32>>;
            fn store_merkle_tree_insertion_by_leaf_index(
                &self,
                leaf_index: &u32,
                insertion: &MerkleTreeInsertion,
            ) -> DbResult<()>;
            fn retrieve_merkle_tree_insertion_by_leaf_index(
                &self,
                leaf_index: &u32,
            ) -> DbResult<Option<MerkleTreeInsertion>>;
            fn store_merkle_leaf_index_by_message_id(
                &self,
                message_id: &H256,
                leaf_index: &u32,
            ) -> DbResult<()>;
            fn retrieve_merkle_leaf_index_by_message_id(&self, message_id: &H256) -> DbResult<Option<u32>>;
            fn store_merkle_tree_insertion_block_number_by_leaf_index(
                &self,
                leaf_index: &u32,
                block_number: &u64,
            ) -> DbResult<()>;
            fn retrieve_merkle_tree_insertion_block_number_by_leaf_index(
                &self,
                leaf_index: &u32,
            ) -> DbResult<Option<u64>>;
            fn store_highest_seen_message_nonce_number(&self, nonce: &u32) -> DbResult<()>;
            fn retrieve_highest_seen_message_nonce_number(&self) -> DbResult<Option<u32>>;
            fn store_payload_ids_by_message_id(&self, message_id: &H256, payload_ids: Vec<UniqueIdentifier>) -> DbResult<()>;
            fn retrieve_payload_ids_by_message_id(&self, message_id: &H256) -> DbResult<Option<Vec<UniqueIdentifier>>>;
        }
    }

    mockall::mock! {
        pub MerkleTreeHook {}

        impl Debug for MerkleTreeHook {
            fn fmt<'a>(&self, f: &mut std::fmt::Formatter<'a>) -> std::fmt::Result;
        }

        impl HyperlaneChain for MerkleTreeHook {
            fn domain(&self) -> &HyperlaneDomain;
            fn provider(&self) -> Box<dyn HyperlaneProvider>;
        }

        impl HyperlaneContract for MerkleTreeHook {
            fn address(&self) -> H256;
        }

        #[async_trait]
        impl MerkleTreeHook for MerkleTreeHook {
            async fn tree(&self, reorg_period: &ReorgPeriod) -> ChainResult<IncrementalMerkle>;
            async fn count(&self, reorg_period: &ReorgPeriod) -> ChainResult<u32>;
            async fn latest_checkpoint(&self, reorg_period: &ReorgPeriod) -> ChainResult<Checkpoint>;
        }
    }

    mockall::mock! {
        pub CheckpointSyncer {}

        impl Debug for CheckpointSyncer {
            fn fmt<'a>(&self, f: &mut std::fmt::Formatter<'a>) -> std::fmt::Result;
        }

        #[async_trait]
        impl CheckpointSyncer for CheckpointSyncer {
            async fn latest_index(&self) -> Result<Option<u32>>;
            async fn write_latest_index(&self, index: u32) -> Result<()>;
            async fn update_latest_index(&self, index: u32) -> Result<()>;
            async fn fetch_checkpoint(&self, index: u32) -> Result<Option<SignedCheckpointWithMessageId>>;
            async fn write_checkpoint(
                &self,
                signed_checkpoint: &SignedCheckpointWithMessageId,
            ) -> Result<()>;
            async fn write_metadata(&self, metadata: &str) -> Result<()>;
            async fn write_announcement(&self, signed_announcement: &SignedAnnouncement) -> Result<()>;
            fn announcement_location(&self) -> String;
            async fn write_reorg_status(&self, reorg_event: &ReorgEvent) -> Result<()>;
            async fn reorg_status(&self) -> Result<Option<ReorgEvent>>;
        }
    }

    fn dummy_metrics() -> ValidatorSubmitterMetrics {
        let origin_domain = dummy_domain(0, "dummy_origin_domain");
        let core_metrics = CoreMetrics::new("dummy_relayer", 37582, Registry::new()).unwrap();
        ValidatorSubmitterMetrics::new(&core_metrics, &origin_domain)
    }

    fn dummy_singleton_handle() -> SingletonSignerHandle {
        SingletonSignerHandle::new(H160::from_low_u64_be(0), mpsc::unbounded_channel().0)
    }

    fn reorg_event_is_correct(
        reorg_event: &ReorgEvent,
        expected_local_merkle_tree: &IncrementalMerkle,
        mock_onchain_merkle_tree: &IncrementalMerkle,
        unix_timestamp: u64,
        expected_reorg_period: ReorgPeriod,
    ) {
        assert_eq!(
            reorg_event.canonical_merkle_root,
            mock_onchain_merkle_tree.root()
        );
        assert_eq!(
            reorg_event.local_merkle_root,
            expected_local_merkle_tree.root()
        );
        assert_eq!(
            reorg_event.checkpoint_index,
            expected_local_merkle_tree.index()
        );
        // timestamp diff should be less than 1 second
        let timestamp_diff = reorg_event.unix_timestamp as i64 - unix_timestamp as i64;
        assert!(timestamp_diff.abs() < 1);

        assert_eq!(reorg_event.reorg_period, expected_reorg_period);
    }

    #[tokio::test]
    #[should_panic(expected = "Incorrect tree root, something went wrong.")]
    async fn reorg_is_detected_and_persisted_to_checkpoint_storage() {
        let unix_timestamp = chrono::Utc::now().timestamp() as u64;
        let expected_reorg_period = 12;

        let pre_reorg_merke_insertions = [
            MerkleTreeInsertion::new(0, H256::random()),
            MerkleTreeInsertion::new(1, H256::random()),
            MerkleTreeInsertion::new(2, H256::random()),
        ];
        let mut expected_local_merkle_tree = IncrementalMerkle::default();
        for insertion in pre_reorg_merke_insertions.iter() {
            expected_local_merkle_tree.ingest(insertion.message_id());
        }

        // the last leaf is different post-reorg
        let post_reorg_merkle_insertions = [
            pre_reorg_merke_insertions[0],
            pre_reorg_merke_insertions[1],
            MerkleTreeInsertion::new(2, H256::random()),
        ];
        let mut mock_onchain_merkle_tree = IncrementalMerkle::default();
        for insertion in post_reorg_merkle_insertions.iter() {
            mock_onchain_merkle_tree.ingest(insertion.message_id());
        }

        // assert the reorg resulted in different merkle tree roots
        assert_ne!(
            mock_onchain_merkle_tree.root(),
            expected_local_merkle_tree.root()
        );

        // the db returns the pre-reorg merkle tree insertions
        let mut db = MockDb::new();
        db.expect_retrieve_merkle_tree_insertion_by_leaf_index()
            .returning(move |sequence| Ok(Some(pre_reorg_merke_insertions[*sequence as usize])));

        // boilerplate mocks
        let mut mock_merkle_tree_hook = MockMerkleTreeHook::new();
        mock_merkle_tree_hook
            .expect_address()
            .returning(|| H256::from_low_u64_be(0));
        let dummy_domain = dummy_domain(0, "dummy_domain");
        mock_merkle_tree_hook
            .expect_domain()
            .return_const(dummy_domain.clone());

        // expect the checkpoint syncer to post the reorg event to the checkpoint storage
        // and not submit any checkpoints (this is checked implicitly, by not setting any `expect`s)
        let mut mock_checkpoint_syncer = MockCheckpointSyncer::new();
        let mock_onchain_merkle_tree_clone = mock_onchain_merkle_tree.clone();
        mock_checkpoint_syncer
            .expect_write_reorg_status()
            .once()
            .returning(move |reorg_event| {
                // unit test correctness criteria
                reorg_event_is_correct(
                    reorg_event,
                    &expected_local_merkle_tree,
                    &mock_onchain_merkle_tree_clone,
                    unix_timestamp,
                    ReorgPeriod::from_blocks(expected_reorg_period),
                );
                Ok(())
            });

        let signer: Signers = "1111111111111111111111111111111111111111111111111111111111111111"
            .parse::<ethers::signers::LocalWallet>()
            .unwrap()
            .into();

        // instantiate the validator submitter
        let validator_submitter = ValidatorSubmitter::new(
            Duration::from_secs(1),
            ReorgPeriod::from_blocks(expected_reorg_period),
            Arc::new(mock_merkle_tree_hook),
            dummy_singleton_handle(),
            signer,
            Arc::new(mock_checkpoint_syncer),
            Arc::new(db),
            dummy_metrics(),
            50,
        );

        // mock the correctness checkpoint response
        let mock_onchain_checkpoint = Checkpoint {
            root: mock_onchain_merkle_tree.root(),
            index: mock_onchain_merkle_tree.index(),
            merkle_tree_hook_address: H256::from_low_u64_be(0),
            mailbox_domain: dummy_domain.id(),
        };

        // Start the submitter with an empty merkle tree, so it gets rebuilt from the db.
        // A panic is expected here, as the merkle root inconsistency is a critical error that may indicate fraud.
        validator_submitter
            .submit_checkpoints_until_correctness_checkpoint(
                &mut IncrementalMerkle::default(),
                &mock_onchain_checkpoint,
            )
            .await;
    }
}
