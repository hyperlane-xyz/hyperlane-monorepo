use std::{
    fmt::Debug,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use async_trait::async_trait;
use eyre::Result;
use prometheus::Registry;
use tokio::sync::mpsc;

use hyperlane_base::tests::mock_hyperlane_db::MockHyperlaneDb as MockDb;
use hyperlane_core::{
    test_utils::dummy_domain, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneProvider, MerkleTreeHook, MerkleTreeInsertion, ReorgEvent, ReorgEventResponse,
    SignedAnnouncement, SignedCheckpointWithMessageId, H160, H256,
};

use super::*;

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
        async fn tree(&self, reorg_period: &ReorgPeriod) -> ChainResult<IncrementalMerkleAtBlock>;
        async fn count(&self, reorg_period: &ReorgPeriod) -> ChainResult<u32>;
        async fn latest_checkpoint(&self, reorg_period: &ReorgPeriod) -> ChainResult<CheckpointAtBlock>;
        async fn latest_checkpoint_at_block(&self, height: u64) -> ChainResult<CheckpointAtBlock>;
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
        async fn reorg_status(&self) -> Result<ReorgEventResponse>;
    }
}

mockall::mock! {
    pub ReorgReporter {}

    impl Debug for ReorgReporter {
        fn fmt<'a>(&self, f: &mut std::fmt::Formatter<'a>) -> std::fmt::Result;
    }

    #[async_trait]
    impl ReorgReporter for ReorgReporter {
        async fn report_at_block(&self, block_height: u64);
        async fn report_with_reorg_period(&self, reorg_period: &ReorgPeriod);
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

#[tokio::test(start_paused = true)]
async fn single_checkpoint_chunk_has_no_throttle_tail() {
    let checkpoint = CheckpointWithMessageId {
        checkpoint: Checkpoint {
            root: H256::zero(),
            merkle_tree_hook_address: H256::zero(),
            mailbox_domain: 0,
            index: 7,
        },
        message_id: H256::zero(),
    };

    let mut checkpoint_syncer = MockCheckpointSyncer::new();
    checkpoint_syncer
        .expect_fetch_checkpoint()
        .once()
        .returning(|_| Ok(None));
    checkpoint_syncer
        .expect_write_checkpoint()
        .once()
        .returning(|_| Ok(()));
    checkpoint_syncer
        .expect_update_latest_index()
        .with(mockall::predicate::eq(checkpoint.index))
        .once()
        .returning(|_| Ok(()));

    let signer: Signers = ethers::signers::LocalWallet::new(&mut rand::thread_rng()).into();
    let submitter = ValidatorSubmitter::new(
        Duration::from_secs(1),
        ReorgPeriod::from_blocks(1),
        Arc::new(MockMerkleTreeHook::new()),
        Arc::new(MockMerkleTreeHook::new()),
        dummy_singleton_handle(),
        signer,
        Arc::new(checkpoint_syncer),
        Arc::new(MockDb::new()),
        dummy_metrics(),
        1,
        Arc::new(MockReorgReporter::new()),
    );

    let task = tokio::spawn(async move {
        submitter
            .sign_and_submit_checkpoints(vec![checkpoint])
            .await;
    });
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_millis(99)).await;
    tokio::task::yield_now().await;

    assert!(
        task.is_finished(),
        "a final checkpoint chunk must not wait for the 100ms inter-chunk throttle"
    );
    task.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn two_written_chunks_have_one_inter_chunk_throttle() {
    let checkpoints = [7, 8].map(|index| CheckpointWithMessageId {
        checkpoint: Checkpoint {
            root: H256::zero(),
            merkle_tree_hook_address: H256::zero(),
            mailbox_domain: 0,
            index,
        },
        message_id: H256::zero(),
    });

    let mut checkpoint_syncer = MockCheckpointSyncer::new();
    checkpoint_syncer
        .expect_fetch_checkpoint()
        .times(checkpoints.len())
        .returning(|_| Ok(None));
    checkpoint_syncer
        .expect_write_checkpoint()
        .times(checkpoints.len())
        .returning(|_| Ok(()));
    checkpoint_syncer
        .expect_update_latest_index()
        .with(mockall::predicate::eq(checkpoints[1].index))
        .once()
        .returning(|_| Ok(()));

    let signer: Signers = ethers::signers::LocalWallet::new(&mut rand::thread_rng()).into();
    let submitter = ValidatorSubmitter::new(
        Duration::from_secs(1),
        ReorgPeriod::from_blocks(1),
        Arc::new(MockMerkleTreeHook::new()),
        Arc::new(MockMerkleTreeHook::new()),
        dummy_singleton_handle(),
        signer,
        Arc::new(checkpoint_syncer),
        Arc::new(MockDb::new()),
        dummy_metrics(),
        1,
        Arc::new(MockReorgReporter::new()),
    );

    let task = tokio::spawn(async move {
        submitter
            .sign_and_submit_checkpoints(checkpoints.to_vec())
            .await;
    });
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_millis(99)).await;
    tokio::task::yield_now().await;

    assert!(
        !task.is_finished(),
        "two written chunks must wait for the 100ms inter-chunk throttle"
    );

    tokio::time::advance(Duration::from_millis(1)).await;
    tokio::task::yield_now().await;

    assert!(
        task.is_finished(),
        "the final written chunk must not add another throttle delay"
    );
    task.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn all_existing_chunks_skip_inter_chunk_throttle() {
    let checkpoints = [7, 8].map(|index| CheckpointWithMessageId {
        checkpoint: Checkpoint {
            root: H256::zero(),
            merkle_tree_hook_address: H256::zero(),
            mailbox_domain: 0,
            index,
        },
        message_id: H256::zero(),
    });

    let signer: Signers = ethers::signers::LocalWallet::new(&mut rand::thread_rng()).into();
    let signed_checkpoints = [
        signer.sign(checkpoints[0]).await.unwrap(),
        signer.sign(checkpoints[1]).await.unwrap(),
    ];

    let mut checkpoint_syncer = MockCheckpointSyncer::new();
    checkpoint_syncer
        .expect_fetch_checkpoint()
        .times(checkpoints.len())
        .returning(move |index| {
            Ok(signed_checkpoints
                .iter()
                .find(|signed| signed.value.index == index)
                .cloned())
        });
    checkpoint_syncer.expect_write_checkpoint().never();
    checkpoint_syncer
        .expect_update_latest_index()
        .with(mockall::predicate::eq(checkpoints[1].index))
        .once()
        .returning(|_| Ok(()));

    let submitter = ValidatorSubmitter::new(
        Duration::from_secs(1),
        ReorgPeriod::from_blocks(1),
        Arc::new(MockMerkleTreeHook::new()),
        Arc::new(MockMerkleTreeHook::new()),
        dummy_singleton_handle(),
        signer,
        Arc::new(checkpoint_syncer),
        Arc::new(MockDb::new()),
        dummy_metrics(),
        1,
        Arc::new(MockReorgReporter::new()),
    );

    let task = tokio::spawn(async move {
        submitter
            .sign_and_submit_checkpoints(checkpoints.to_vec())
            .await;
    });
    tokio::task::yield_now().await;

    assert!(
        task.is_finished(),
        "all-existing chunks must not wait for the inter-chunk throttle"
    );
    task.await.unwrap();
}

/// Regression test for the public-RPC load fix: `checkpoint_submitter` must not call the
/// quorum-verified, public-RPC-fanning `latest_checkpoint()` when the cheap, base-hook-only
/// `count()` shows nothing new since `tree` was last caught up.
#[tokio::test(start_paused = true)]
async fn checkpoint_submitter_skips_latest_checkpoint_without_new_messages() {
    let mut tree = IncrementalMerkle::default();
    tree.ingest(H256::from_low_u64_be(1));
    tree.ingest(H256::from_low_u64_be(2));
    tree.ingest(H256::from_low_u64_be(3));
    let tree_count = tree.count() as u32;

    let count_calls = Arc::new(AtomicBool::new(false));
    let count_calls_clone = count_calls.clone();

    let mut mock_quorum_merkle_tree_hook = MockMerkleTreeHook::new();
    mock_quorum_merkle_tree_hook
        .expect_address()
        .returning(|| H256::from_low_u64_be(0));
    let dummy_domain = dummy_domain(0, "dummy_domain");
    mock_quorum_merkle_tree_hook
        .expect_domain()
        .return_const(dummy_domain.clone());
    mock_quorum_merkle_tree_hook
        .expect_latest_checkpoint()
        .never();

    let mut mock_base_merkle_tree_hook = MockMerkleTreeHook::new();
    mock_base_merkle_tree_hook
        .expect_count()
        .returning(move |_| {
            count_calls_clone.store(true, Ordering::SeqCst);
            Ok(tree_count)
        });
    let expected_checkpoint = CheckpointAtBlock {
        checkpoint: Checkpoint {
            root: tree.root(),
            index: tree.index(),
            merkle_tree_hook_address: H256::from_low_u64_be(0),
            mailbox_domain: dummy_domain.id(),
        },
        block_height: Some(1),
    };
    mock_base_merkle_tree_hook
        .expect_latest_checkpoint()
        .returning(move |_| Ok(expected_checkpoint.clone()));

    let signer: Signers = ethers::signers::LocalWallet::new(&mut rand::thread_rng()).into();
    let submitter = ValidatorSubmitter::new(
        Duration::from_secs(1),
        ReorgPeriod::from_blocks(1),
        Arc::new(mock_quorum_merkle_tree_hook),
        Arc::new(mock_base_merkle_tree_hook),
        dummy_singleton_handle(),
        signer,
        Arc::new(MockCheckpointSyncer::new()),
        Arc::new(MockDb::new()),
        dummy_metrics(),
        1,
        Arc::new(MockReorgReporter::new()),
    );

    let task = tokio::spawn(async move {
        submitter.checkpoint_submitter(tree).await;
    });

    for _ in 0..5 {
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(1)).await;
    }
    tokio::task::yield_now().await;
    task.abort();
    let _ = task.await;

    assert!(
        count_calls.load(Ordering::SeqCst),
        "the loop should still poll count() via the private base_hook"
    );
    // `mock_quorum_merkle_tree_hook.expect_latest_checkpoint().never()` above is the real
    // assertion: a panic there would have failed this test already if it were called.
}

/// Regression test for a race where `count()` returns the local count, but a leaf lands
/// before `base_hook.latest_checkpoint()` resolves. The ahead checkpoint must be
/// quorum-verified before it can drive signing.
#[tokio::test(start_paused = true)]
async fn checkpoint_submitter_quorum_verifies_base_checkpoint_ahead_of_observed_count() {
    let mut tree = IncrementalMerkle::default();
    tree.ingest(H256::from_low_u64_be(1));
    tree.ingest(H256::from_low_u64_be(2));
    let tree_count = tree.count() as u32;

    let mut ahead_tree = tree.clone();
    ahead_tree.ingest(H256::from_low_u64_be(3));

    let dummy_domain = dummy_domain(0, "dummy_domain");

    let quorum_latest_checkpoint_called = Arc::new(AtomicBool::new(false));
    let quorum_latest_checkpoint_called_clone = quorum_latest_checkpoint_called.clone();

    let mut mock_quorum_merkle_tree_hook = MockMerkleTreeHook::new();
    mock_quorum_merkle_tree_hook
        .expect_address()
        .returning(|| H256::from_low_u64_be(0));
    mock_quorum_merkle_tree_hook
        .expect_domain()
        .return_const(dummy_domain.clone());
    let local_checkpoint = CheckpointAtBlock {
        checkpoint: Checkpoint {
            root: tree.root(),
            index: tree.index(),
            merkle_tree_hook_address: H256::from_low_u64_be(0),
            mailbox_domain: dummy_domain.id(),
        },
        block_height: Some(1),
    };
    mock_quorum_merkle_tree_hook
        .expect_latest_checkpoint()
        .once()
        .returning(move |_| {
            quorum_latest_checkpoint_called_clone.store(true, Ordering::SeqCst);
            Ok(local_checkpoint.clone())
        });

    let mut mock_base_merkle_tree_hook = MockMerkleTreeHook::new();
    mock_base_merkle_tree_hook
        .expect_count()
        .once()
        .returning(move |_| Ok(tree_count));
    let base_ahead_checkpoint = CheckpointAtBlock {
        checkpoint: Checkpoint {
            root: ahead_tree.root(),
            index: ahead_tree.index(),
            merkle_tree_hook_address: H256::from_low_u64_be(0),
            mailbox_domain: dummy_domain.id(),
        },
        block_height: Some(2),
    };
    mock_base_merkle_tree_hook
        .expect_latest_checkpoint()
        .once()
        .returning(move |_| Ok(base_ahead_checkpoint.clone()));

    let signer: Signers = ethers::signers::LocalWallet::new(&mut rand::thread_rng()).into();
    let submitter = ValidatorSubmitter::new(
        Duration::from_secs(1),
        ReorgPeriod::from_blocks(1),
        Arc::new(mock_quorum_merkle_tree_hook),
        Arc::new(mock_base_merkle_tree_hook),
        dummy_singleton_handle(),
        signer,
        Arc::new(MockCheckpointSyncer::new()),
        Arc::new(MockDb::new()),
        dummy_metrics(),
        1,
        Arc::new(MockReorgReporter::new()),
    );

    let task = tokio::spawn(async move {
        submitter.checkpoint_submitter(tree).await;
    });

    for _ in 0..5 {
        tokio::task::yield_now().await;
    }
    task.abort();
    let _ = task.await;

    assert!(
        quorum_latest_checkpoint_called.load(Ordering::SeqCst),
        "base checkpoint ahead of observed count must be quorum-verified"
    );
}

/// Regression test for same-index reorg detection: an unchanged count with a changed root
/// must still go through the normal reorg reporting/panic path.
#[tokio::test(start_paused = true)]
async fn checkpoint_submitter_detects_reorg_when_count_is_unchanged() {
    let expected_reorg_period = 12;

    let mut local_tree = IncrementalMerkle::default();
    local_tree.ingest(H256::from_low_u64_be(1));
    local_tree.ingest(H256::from_low_u64_be(2));
    local_tree.ingest(H256::from_low_u64_be(3));

    let mut onchain_tree = IncrementalMerkle::default();
    onchain_tree.ingest(H256::from_low_u64_be(1));
    onchain_tree.ingest(H256::from_low_u64_be(2));
    onchain_tree.ingest(H256::from_low_u64_be(4));

    assert_eq!(local_tree.count(), onchain_tree.count());
    assert_ne!(local_tree.root(), onchain_tree.root());

    let dummy_domain = dummy_domain(0, "dummy_domain");

    let mut mock_quorum_merkle_tree_hook = MockMerkleTreeHook::new();
    mock_quorum_merkle_tree_hook
        .expect_address()
        .returning(|| H256::from_low_u64_be(0));
    mock_quorum_merkle_tree_hook
        .expect_domain()
        .return_const(dummy_domain.clone());

    let mut mock_base_merkle_tree_hook = MockMerkleTreeHook::new();
    let observed_count = local_tree.count() as u32;
    mock_base_merkle_tree_hook
        .expect_count()
        .once()
        .returning(move |_| Ok(observed_count));
    let onchain_checkpoint = CheckpointAtBlock {
        checkpoint: Checkpoint {
            root: onchain_tree.root(),
            index: onchain_tree.index(),
            merkle_tree_hook_address: H256::from_low_u64_be(0),
            mailbox_domain: dummy_domain.id(),
        },
        block_height: Some(42),
    };
    let quorum_checkpoint = onchain_checkpoint.clone();
    mock_quorum_merkle_tree_hook
        .expect_latest_checkpoint()
        .once()
        .returning(move |_| Ok(quorum_checkpoint.clone()));
    mock_base_merkle_tree_hook
        .expect_latest_checkpoint()
        .once()
        .return_once(move |_| Ok(onchain_checkpoint));

    let unix_timestamp = chrono::Utc::now().timestamp() as u64;
    let mut mock_checkpoint_syncer = MockCheckpointSyncer::new();
    let expected_local_tree = local_tree.clone();
    let expected_onchain_tree = onchain_tree.clone();
    mock_checkpoint_syncer
        .expect_write_reorg_status()
        .once()
        .returning(move |reorg_event| {
            reorg_event_is_correct(
                reorg_event,
                &expected_local_tree,
                &expected_onchain_tree,
                unix_timestamp,
                ReorgPeriod::from_blocks(expected_reorg_period),
            );
            Ok(())
        });

    let mut mock_reorg_reporter = MockReorgReporter::new();
    mock_reorg_reporter
        .expect_report_at_block()
        .with(mockall::predicate::eq(42))
        .once()
        .return_once(|_| {});

    let signer: Signers = ethers::signers::LocalWallet::new(&mut rand::thread_rng()).into();
    let submitter = ValidatorSubmitter::new(
        Duration::from_secs(1),
        ReorgPeriod::from_blocks(expected_reorg_period),
        Arc::new(mock_quorum_merkle_tree_hook),
        Arc::new(mock_base_merkle_tree_hook),
        dummy_singleton_handle(),
        signer,
        Arc::new(mock_checkpoint_syncer),
        Arc::new(MockDb::new()),
        dummy_metrics(),
        1,
        Arc::new(mock_reorg_reporter),
    );

    let task = tokio::spawn(async move {
        submitter.checkpoint_submitter(local_tree).await;
    });
    tokio::task::yield_now().await;

    assert!(
        task.is_finished(),
        "unchanged-count root mismatch should panic in the first loop"
    );
    let result = task.await;
    assert!(result.unwrap_err().is_panic());
}

/// Counterpart to the above: once the cheap `count()` shows a new leaf, `latest_checkpoint()`
/// (the quorum-verified, public-RPC-fanning read) must still be called to determine what to
/// sign.
#[tokio::test(start_paused = true)]
async fn checkpoint_submitter_fetches_latest_checkpoint_when_new_message_arrives() {
    let mut tree = IncrementalMerkle::default();
    tree.ingest(H256::from_low_u64_be(1));
    tree.ingest(H256::from_low_u64_be(2));
    let unchanged_tree = tree.clone();

    let latest_checkpoint_called = Arc::new(AtomicBool::new(false));
    let latest_checkpoint_called_clone = latest_checkpoint_called.clone();

    let mut mock_quorum_merkle_tree_hook = MockMerkleTreeHook::new();
    mock_quorum_merkle_tree_hook
        .expect_address()
        .returning(|| H256::from_low_u64_be(0));
    let dummy_domain = dummy_domain(0, "dummy_domain");
    mock_quorum_merkle_tree_hook
        .expect_domain()
        .return_const(dummy_domain.clone());
    // One more leaf is available on-chain than what's locally ingested.
    let observed_count = unchanged_tree.count() as u32 + 1;
    let mut mock_base_merkle_tree_hook = MockMerkleTreeHook::new();
    mock_base_merkle_tree_hook
        .expect_count()
        .returning(move |_| Ok(observed_count));
    mock_quorum_merkle_tree_hook
        .expect_latest_checkpoint()
        .returning(move |_| {
            latest_checkpoint_called_clone.store(true, Ordering::SeqCst);
            // Reports the checkpoint as already matching the current tree, so the
            // submitter has nothing further to ingest/sign in this test.
            Ok(CheckpointAtBlock {
                checkpoint: Checkpoint {
                    root: unchanged_tree.root(),
                    index: unchanged_tree.index(),
                    merkle_tree_hook_address: H256::from_low_u64_be(0),
                    mailbox_domain: dummy_domain.id(),
                },
                block_height: Some(1),
            })
        });

    let signer: Signers = ethers::signers::LocalWallet::new(&mut rand::thread_rng()).into();
    let submitter = ValidatorSubmitter::new(
        Duration::from_secs(1),
        ReorgPeriod::from_blocks(1),
        Arc::new(mock_quorum_merkle_tree_hook),
        Arc::new(mock_base_merkle_tree_hook),
        dummy_singleton_handle(),
        signer,
        Arc::new(MockCheckpointSyncer::new()),
        Arc::new(MockDb::new()),
        dummy_metrics(),
        1,
        Arc::new(MockReorgReporter::new()),
    );

    let task = tokio::spawn(async move {
        submitter.checkpoint_submitter(tree).await;
    });

    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_secs(1)).await;
    tokio::task::yield_now().await;
    task.abort();
    let _ = task.await;

    assert!(
        latest_checkpoint_called.load(Ordering::SeqCst),
        "latest_checkpoint() should be called once count() indicates a new leaf"
    );
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
    // timestamp diff should be less than 5 seconds
    let timestamp_diff = reorg_event.unix_timestamp as i64 - unix_timestamp as i64;
    assert!(
        timestamp_diff.abs() < 5,
        "timestamp_diff {} should be < 5",
        timestamp_diff
    );

    assert_eq!(reorg_event.reorg_period, expected_reorg_period);
}

#[tokio::test]
#[should_panic(
    expected = "Incorrect tree root. Most likely a reorg has occurred. Please reach out for help, this is a potentially serious error impacting signed messages. Do NOT forcefully resume operation of this validator. Keep it crashlooping or shut down until you receive support."
)]
async fn reorg_is_detected_and_persisted_to_checkpoint_storage() {
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
    let unix_timestamp = chrono::Utc::now().timestamp() as u64;
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

    let mut mock_reorg_reporter = MockReorgReporter::new();
    mock_reorg_reporter
        .expect_report_at_block()
        .once()
        .return_once(|_| {});

    // instantiate the validator submitter
    let validator_submitter = ValidatorSubmitter::new(
        Duration::from_secs(1),
        ReorgPeriod::from_blocks(expected_reorg_period),
        Arc::new(mock_merkle_tree_hook),
        Arc::new(MockMerkleTreeHook::new()),
        dummy_singleton_handle(),
        signer,
        Arc::new(mock_checkpoint_syncer),
        Arc::new(db),
        dummy_metrics(),
        50,
        Arc::new(mock_reorg_reporter),
    );

    // mock the correctness checkpoint response
    let mock_onchain_checkpoint = Checkpoint {
        root: mock_onchain_merkle_tree.root(),
        index: mock_onchain_merkle_tree.index(),
        merkle_tree_hook_address: H256::from_low_u64_be(0),
        mailbox_domain: dummy_domain.id(),
    };
    let mock_onchain_checkpoint = CheckpointAtBlock {
        checkpoint: mock_onchain_checkpoint,
        block_height: Some(42),
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

#[tokio::test]
#[tracing_test::traced_test]
async fn sign_and_submit_checkpoint_same_signature() {
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

    // mock the correctness checkpoint response
    let mock_onchain_checkpoint = Checkpoint {
        root: mock_onchain_merkle_tree.root(),
        index: mock_onchain_merkle_tree.index(),
        merkle_tree_hook_address: H256::from_low_u64_be(0),
        mailbox_domain: dummy_domain.id(),
    };
    let mock_onchain_checkpoint = CheckpointWithMessageId {
        checkpoint: mock_onchain_checkpoint,
        message_id: H256::zero(),
    };

    let signer: Signers = "1111111111111111111111111111111111111111111111111111111111111111"
        .parse::<ethers::signers::LocalWallet>()
        .unwrap()
        .into();

    let mock_onchain_checkpoint_clone = mock_onchain_checkpoint;
    let signed_type = signer.sign(mock_onchain_checkpoint_clone).await.unwrap();
    mock_checkpoint_syncer
        .expect_fetch_checkpoint()
        .once()
        .returning(move |_| {
            Ok(Some(SignedType {
                value: signed_type.value,
                signature: signed_type.signature,
            }))
        });

    let mock_reorg_reporter = MockReorgReporter::new();

    // instantiate the validator submitter
    let validator_submitter = ValidatorSubmitter::new(
        Duration::from_secs(1),
        ReorgPeriod::from_blocks(expected_reorg_period),
        Arc::new(mock_merkle_tree_hook),
        Arc::new(MockMerkleTreeHook::new()),
        dummy_singleton_handle(),
        signer,
        Arc::new(mock_checkpoint_syncer),
        Arc::new(db),
        dummy_metrics(),
        50,
        Arc::new(mock_reorg_reporter),
    );

    // Start the submitter with an empty merkle tree, so it gets rebuilt from the db.
    // A panic is expected here, as the merkle root inconsistency is a critical error that may indicate fraud.
    let _ = validator_submitter
        .sign_and_submit_checkpoint(mock_onchain_checkpoint)
        .await;

    logs_contain("Checkpoint already submitted");
}

#[tokio::test]
#[tracing_test::traced_test]
async fn sign_and_submit_checkpoint_different_signature() {
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

    // mock the correctness checkpoint response
    let mock_onchain_checkpoint = Checkpoint {
        root: mock_onchain_merkle_tree.root(),
        index: mock_onchain_merkle_tree.index(),
        merkle_tree_hook_address: H256::from_low_u64_be(0),
        mailbox_domain: dummy_domain.id(),
    };
    let mock_onchain_checkpoint = CheckpointWithMessageId {
        checkpoint: mock_onchain_checkpoint,
        message_id: H256::zero(),
    };

    let signer: Signers = "1111111111111111111111111111111111111111111111111111111111111111"
        .parse::<ethers::signers::LocalWallet>()
        .unwrap()
        .into();

    let signed_type = signer
        .sign(CheckpointWithMessageId {
            checkpoint: Checkpoint {
                root: H256::zero(),
                merkle_tree_hook_address: H256::zero(),
                mailbox_domain: 0,
                index: 0,
            },
            message_id: H256::zero(),
        })
        .await
        .unwrap();
    mock_checkpoint_syncer
        .expect_fetch_checkpoint()
        .once()
        .returning(move |_| {
            Ok(Some(SignedType {
                value: signed_type.value,
                signature: signed_type.signature,
            }))
        });
    mock_checkpoint_syncer
        .expect_write_checkpoint()
        .once()
        .returning(|_| Ok(()));

    let mock_reorg_reporter = MockReorgReporter::new();

    // instantiate the validator submitter
    let validator_submitter = ValidatorSubmitter::new(
        Duration::from_secs(1),
        ReorgPeriod::from_blocks(expected_reorg_period),
        Arc::new(mock_merkle_tree_hook),
        Arc::new(MockMerkleTreeHook::new()),
        dummy_singleton_handle(),
        signer,
        Arc::new(mock_checkpoint_syncer),
        Arc::new(db),
        dummy_metrics(),
        50,
        Arc::new(mock_reorg_reporter),
    );

    // Start the submitter with an empty merkle tree, so it gets rebuilt from the db.
    // A panic is expected here, as the merkle root inconsistency is a critical error that may indicate fraud.
    let _ = validator_submitter
        .sign_and_submit_checkpoint(mock_onchain_checkpoint)
        .await;

    logs_contain("Checkpoint already submitted, but with different signature, overwriting");
}
