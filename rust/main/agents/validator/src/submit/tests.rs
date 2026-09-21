use std::{
    fmt::Debug,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
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
use crate::server::ValidatorReadinessState;

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
        async fn read_merkle_snapshot(&self) -> Result<Option<MerkleTreeSnapshot>>;
        async fn write_merkle_snapshot(&self, snapshot: &MerkleTreeSnapshot) -> Result<()>;
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

fn dummy_readiness() -> Arc<ValidatorReadiness> {
    Arc::new(ValidatorReadiness::default())
}

fn dummy_submitter(interval: Duration) -> ValidatorSubmitter {
    let signer: Signers = ethers::signers::LocalWallet::new(&mut rand::thread_rng()).into();
    ValidatorSubmitter::new(
        interval,
        ReorgPeriod::from_blocks(1),
        Arc::new(MockMerkleTreeHook::new()),
        dummy_singleton_handle(),
        signer,
        Arc::new(MockCheckpointSyncer::new()),
        Arc::new(MockDb::new()),
        dummy_metrics(),
        1,
        Some(Arc::new(MockReorgReporter::new())),
        dummy_readiness(),
    )
}

#[tokio::test(start_paused = true)]
async fn checkpoint_check_wakes_on_verified_insertion_hint() {
    let checkpoint_wake = Arc::new(Notify::new());
    let submitter = dummy_submitter(Duration::from_secs(60))
        .with_checkpoint_wake(Some(checkpoint_wake.clone()));
    let task = tokio::spawn(async move { submitter.wait_for_checkpoint_check().await });

    tokio::task::yield_now().await;
    assert!(!task.is_finished());
    checkpoint_wake.notify_one();
    tokio::task::yield_now().await;

    assert!(task.is_finished());
    task.await.expect("checkpoint wait task");
}

#[tokio::test(start_paused = true)]
async fn checkpoint_check_retains_interval_fallback() {
    let checkpoint_wake = Arc::new(Notify::new());
    let submitter =
        dummy_submitter(Duration::from_secs(60)).with_checkpoint_wake(Some(checkpoint_wake));
    let task = tokio::spawn(async move { submitter.wait_for_checkpoint_check().await });

    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_secs(59)).await;
    tokio::task::yield_now().await;
    assert!(!task.is_finished());

    tokio::time::advance(Duration::from_secs(1)).await;
    tokio::task::yield_now().await;
    assert!(task.is_finished());
    task.await.expect("checkpoint wait task");
}

#[test]
#[should_panic(expected = "maxSignConcurrency must be greater than zero")]
fn validator_submitter_rejects_zero_sign_concurrency() {
    let signer: Signers = ethers::signers::LocalWallet::new(&mut rand::thread_rng()).into();
    ValidatorSubmitter::new(
        Duration::from_secs(1),
        ReorgPeriod::from_blocks(1),
        Arc::new(MockMerkleTreeHook::new()),
        dummy_singleton_handle(),
        signer,
        Arc::new(MockCheckpointSyncer::new()),
        Arc::new(MockDb::new()),
        dummy_metrics(),
        0,
        Some(Arc::new(MockReorgReporter::new())),
        dummy_readiness(),
    );
}

fn submission_test_submitter(
    syncer: MockCheckpointSyncer,
    readiness: Arc<ValidatorReadiness>,
) -> ValidatorSubmitter {
    let signer: Signers = ethers::signers::LocalWallet::new(&mut rand::thread_rng()).into();
    ValidatorSubmitter::new(
        Duration::from_secs(1),
        ReorgPeriod::from_blocks(1),
        Arc::new(MockMerkleTreeHook::new()),
        dummy_singleton_handle(),
        signer,
        Arc::new(syncer),
        Arc::new(MockDb::new()),
        dummy_metrics(),
        2,
        Some(Arc::new(MockReorgReporter::new())),
        readiness,
    )
}

fn submission_checkpoint(index: u32) -> CheckpointWithMessageId {
    CheckpointWithMessageId {
        checkpoint: Checkpoint {
            root: H256::zero(),
            merkle_tree_hook_address: H256::zero(),
            mailbox_domain: 0,
            index,
        },
        message_id: H256::zero(),
    }
}

#[test]
fn compact_checkpoint_queue_entry_layout() {
    let full = std::mem::size_of::<CheckpointWithMessageId>();
    let compact = std::mem::size_of::<QueuedCheckpoint>();
    println!("checkpoint queue logical entry bytes: {full} -> {compact}");
    assert!(compact < full);
}

#[tokio::test(start_paused = true)]
async fn compact_queue_replays_exact_checkpoints_only_after_final_insertion() {
    let namespace = Checkpoint {
        root: H256::zero(),
        merkle_tree_hook_address: H256::from_low_u64_be(123),
        mailbox_domain: 17,
        index: 0,
    };
    let mut tree = IncrementalMerkle::default();
    let expected: Vec<_> = (0..5)
        .map(|index| {
            let message_id = H256::from_low_u64_be(u64::from(index) + 1);
            tree.ingest(message_id);
            CheckpointWithMessageId {
                checkpoint: Checkpoint {
                    root: tree.root(),
                    index,
                    ..namespace
                },
                message_id,
            }
        })
        .collect();
    let final_read = Arc::new(AtomicBool::new(false));
    let mut db = MockDb::new();
    db.expect_retrieve_merkle_tree_insertion_by_leaf_index()
        .times(5)
        .returning({
            let expected = expected.clone();
            let final_read = Arc::clone(&final_read);
            move |index| {
                let index = *index;
                if index == 4 {
                    final_read.store(true, Ordering::SeqCst);
                }
                Ok(Some(MerkleTreeInsertion::new(
                    index,
                    expected[index as usize].message_id,
                )))
            }
        });
    let signer: Signers = ethers::signers::LocalWallet::new(&mut rand::thread_rng()).into();
    let signer_address = signer.eth_address();
    let writes = Arc::new(std::sync::Mutex::new(Vec::new()));
    let mut syncer = MockCheckpointSyncer::new();
    syncer.expect_fetch_checkpoint().times(5).returning({
        let final_read = Arc::clone(&final_read);
        move |_| {
            assert!(final_read.load(Ordering::SeqCst));
            Ok(None)
        }
    });
    syncer.expect_write_checkpoint().times(5).returning({
        let expected = expected.clone();
        let writes = Arc::clone(&writes);
        move |signed| {
            assert_eq!(signed.value, expected[signed.value.index as usize]);
            assert_eq!(signed.recover().unwrap(), signer_address);
            writes.lock().unwrap().push(signed.value.index);
            Ok(())
        }
    });
    syncer
        .expect_update_latest_index()
        .with(mockall::predicate::eq(4))
        .once()
        .returning(|_| Ok(()));
    let mut hook = MockMerkleTreeHook::new();
    hook.expect_address()
        .return_const(namespace.merkle_tree_hook_address);
    hook.expect_domain()
        .return_const(dummy_domain(17, "queue_domain"));
    let submitter = ValidatorSubmitter::new(
        Duration::from_secs(1),
        ReorgPeriod::from_blocks(1),
        Arc::new(hook),
        dummy_singleton_handle(),
        signer,
        Arc::new(syncer),
        Arc::new(db),
        dummy_metrics(),
        2,
        Some(Arc::new(MockReorgReporter::new())),
        dummy_readiness(),
    );
    submitter
        .submit_checkpoints_until_correctness_checkpoint(
            &mut IncrementalMerkle::default(),
            &CheckpointAtBlock {
                checkpoint: expected[4].checkpoint,
                block_height: Some(1),
            },
        )
        .await;
    // Each chunk completes before the next starts; sibling completion order is unconstrained.
    let writes = writes.lock().unwrap();
    let mut first = writes[..2].to_vec();
    first.sort_unstable();
    let mut second = writes[2..4].to_vec();
    second.sort_unstable();
    assert_eq!(first, vec![3, 4]);
    assert_eq!(second, vec![1, 2]);
    assert_eq!(writes[4], 0);
}

#[tokio::test(start_paused = true)]
async fn compact_queue_materializes_only_the_active_chunk() {
    let materialized = Arc::new(AtomicUsize::new(0));
    let attempts = Arc::new(AtomicUsize::new(0));
    let mut syncer = MockCheckpointSyncer::new();
    syncer.expect_fetch_checkpoint().times(2).returning({
        let attempts = Arc::clone(&attempts);
        move |_| {
            attempts.fetch_add(1, Ordering::SeqCst);
            Err(eyre::eyre!("storage temporarily unavailable"))
        }
    });
    let submitter = submission_test_submitter(syncer, dummy_readiness());
    let task = tokio::spawn({
        let materialized = Arc::clone(&materialized);
        async move {
            submitter
                .sign_and_submit_checkpoints((0..100).map(move |index| {
                    materialized.fetch_add(1, Ordering::SeqCst);
                    QueuedCheckpoint {
                        root: H256::zero(),
                        index,
                        message_id: H256::zero(),
                    }
                    .into_checkpoint(submission_checkpoint(99).checkpoint)
                }))
                .await;
        }
    });
    while attempts.load(Ordering::SeqCst) < 2 {
        tokio::task::yield_now().await;
    }
    assert_eq!(materialized.load(Ordering::SeqCst), 2);
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert_eq!(materialized.load(Ordering::SeqCst), 2);
}

#[tokio::test(start_paused = true)]
async fn checkpoint_chunks_preserve_boundaries_and_publication_across_join_all_threshold() {
    for chunk_size in [1, 6, 30, 31, 50] {
        let count = chunk_size * 2 + 1;
        let writes = Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut syncer = MockCheckpointSyncer::new();
        syncer
            .expect_fetch_checkpoint()
            .times(count)
            .returning(|_| Ok(None));
        syncer.expect_write_checkpoint().times(count).returning({
            let writes = Arc::clone(&writes);
            move |checkpoint| {
                writes.lock().unwrap().push(checkpoint.value.index);
                Ok(())
            }
        });
        syncer
            .expect_update_latest_index()
            .with(mockall::predicate::eq((count - 1) as u32))
            .once()
            .returning(|_| Ok(()));
        let mut submitter = submission_test_submitter(syncer, dummy_readiness());
        submitter.max_sign_concurrency = chunk_size;
        let start = tokio::time::Instant::now();
        submitter
            .sign_and_submit_checkpoints((0..count as u32).map(submission_checkpoint))
            .await;
        assert_eq!(start.elapsed(), Duration::from_millis(200));
        let writes = writes.lock().unwrap();
        for (chunk, expected) in writes.chunks(chunk_size).zip(
            (0..count as u32)
                .rev()
                .collect::<Vec<_>>()
                .chunks(chunk_size),
        ) {
            let mut actual = chunk.to_vec();
            actual.sort_unstable();
            let mut expected = expected.to_vec();
            expected.sort_unstable();
            assert_eq!(actual, expected);
        }
    }
}

#[tokio::test(start_paused = true)]
async fn latest_index_waits_for_newest_checkpoint_but_not_older_siblings() {
    for failing_index in [7, 8] {
        let attempts = Arc::new(AtomicUsize::new(0));
        let failures = Arc::new(AtomicUsize::new(0));
        let newest_written = Arc::new(AtomicBool::new(false));
        let published = Arc::new(AtomicBool::new(false));
        let mut syncer = MockCheckpointSyncer::new();
        syncer
            .expect_fetch_checkpoint()
            .times(3)
            .returning(|_| Ok(None));
        syncer.expect_write_checkpoint().times(3).returning({
            let attempts = Arc::clone(&attempts);
            let failures = Arc::clone(&failures);
            let newest_written = Arc::clone(&newest_written);
            move |checkpoint| {
                attempts.fetch_add(1, Ordering::SeqCst);
                if checkpoint.value.index == failing_index
                    && failures.fetch_add(1, Ordering::SeqCst) == 0
                {
                    return Err(eyre::eyre!("transient checkpoint upload failure"));
                }
                if checkpoint.value.index == 8 {
                    newest_written.store(true, Ordering::SeqCst);
                }
                Ok(())
            }
        });
        syncer
            .expect_update_latest_index()
            .with(mockall::predicate::eq(8))
            .once()
            .returning({
                let newest_written = Arc::clone(&newest_written);
                let published = Arc::clone(&published);
                move |_| {
                    assert!(newest_written.load(Ordering::SeqCst));
                    published.store(true, Ordering::SeqCst);
                    Ok(())
                }
            });
        let readiness = dummy_readiness();
        let submitter = submission_test_submitter(syncer, Arc::clone(&readiness));
        let task = tokio::spawn(async move {
            submitter
                .sign_and_submit_checkpoints(vec![
                    submission_checkpoint(7),
                    submission_checkpoint(8),
                ])
                .await;
        });
        while attempts.load(Ordering::SeqCst) < 2 {
            tokio::task::yield_now().await;
        }
        assert_eq!(published.load(Ordering::SeqCst), failing_index == 7);
        assert!(
            !task.is_finished(),
            "the failed sibling must still be retried"
        );
        assert_eq!(
            readiness.snapshot().blocked_operations,
            vec![format!("checkpoint_submission[{failing_index}]")]
        );
        tokio::time::advance(hyperlane_core::rpc_clients::RPC_RETRY_SLEEP_DURATION).await;
        task.await.unwrap();
        assert!(published.load(Ordering::SeqCst));
        assert_eq!(attempts.load(Ordering::SeqCst), 3);
        assert_eq!(readiness.snapshot().state, ValidatorReadinessState::Ready);
    }
}

#[tokio::test(start_paused = true)]
async fn latest_index_retry_does_not_repeat_checkpoint_upload() {
    let updates = Arc::new(AtomicUsize::new(0));
    let mut syncer = MockCheckpointSyncer::new();
    syncer
        .expect_fetch_checkpoint()
        .once()
        .returning(|_| Ok(None));
    syncer
        .expect_write_checkpoint()
        .once()
        .returning(|_| Ok(()));
    syncer
        .expect_update_latest_index()
        .with(mockall::predicate::eq(8))
        .times(2)
        .returning({
            let updates = Arc::clone(&updates);
            move |_| {
                if updates.fetch_add(1, Ordering::SeqCst) == 0 {
                    Err(eyre::eyre!("latest index unavailable"))
                } else {
                    Ok(())
                }
            }
        });
    let readiness = dummy_readiness();
    let submitter = submission_test_submitter(syncer, Arc::clone(&readiness));
    let task = tokio::spawn(async move {
        submitter
            .sign_and_submit_checkpoints(vec![submission_checkpoint(8)])
            .await;
    });
    while updates.load(Ordering::SeqCst) == 0 {
        tokio::task::yield_now().await;
    }
    assert_eq!(
        readiness.snapshot().blocked_operations,
        vec!["checkpoint_latest_index"]
    );
    tokio::time::advance(hyperlane_core::rpc_clients::RPC_RETRY_SLEEP_DURATION).await;
    task.await.unwrap();
    assert_eq!(updates.load(Ordering::SeqCst), 2);
    assert_eq!(readiness.snapshot().state, ValidatorReadinessState::Ready);
}

#[tokio::test(start_paused = true)]
async fn only_first_checkpoint_publishes_batch_maximum() {
    let mut syncer = MockCheckpointSyncer::new();
    syncer
        .expect_fetch_checkpoint()
        .times(3)
        .returning(|_| Ok(None));
    syncer
        .expect_write_checkpoint()
        .times(3)
        .returning(|_| Ok(()));
    syncer
        .expect_update_latest_index()
        .with(mockall::predicate::eq(8))
        .once()
        .returning(|_| Ok(()));
    let submitter = submission_test_submitter(syncer, dummy_readiness());
    submitter
        .sign_and_submit_checkpoints(vec![
            submission_checkpoint(7),
            submission_checkpoint(8),
            submission_checkpoint(8),
        ])
        .await;
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
        dummy_singleton_handle(),
        signer,
        Arc::new(checkpoint_syncer),
        Arc::new(MockDb::new()),
        dummy_metrics(),
        1,
        Some(Arc::new(MockReorgReporter::new())),
        dummy_readiness(),
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
async fn checkpoint_submission_failure_blocks_readiness_until_recovery() {
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
        .times(2)
        .returning(|_| Ok(None));
    let write_calls = Arc::new(AtomicUsize::new(0));
    checkpoint_syncer
        .expect_write_checkpoint()
        .times(2)
        .returning({
            let write_calls = Arc::clone(&write_calls);
            move |_| {
                if write_calls.fetch_add(1, Ordering::SeqCst) == 0 {
                    Err(eyre::eyre!("storage unavailable"))
                } else {
                    Ok(())
                }
            }
        });
    checkpoint_syncer
        .expect_update_latest_index()
        .with(mockall::predicate::eq(checkpoint.index))
        .once()
        .returning(|_| Ok(()));

    let readiness = Arc::new(ValidatorReadiness::default());
    let signer: Signers = ethers::signers::LocalWallet::new(&mut rand::thread_rng()).into();
    let submitter = ValidatorSubmitter::new(
        Duration::from_secs(1),
        ReorgPeriod::from_blocks(1),
        Arc::new(MockMerkleTreeHook::new()),
        dummy_singleton_handle(),
        signer,
        Arc::new(checkpoint_syncer),
        Arc::new(MockDb::new()),
        dummy_metrics(),
        1,
        Some(Arc::new(MockReorgReporter::new())),
        Arc::clone(&readiness),
    );

    let task = tokio::spawn(async move {
        submitter
            .sign_and_submit_checkpoints(vec![checkpoint])
            .await;
    });
    while write_calls.load(Ordering::SeqCst) == 0 {
        tokio::task::yield_now().await;
    }

    let blocked = readiness.snapshot();
    assert_eq!(blocked.state, ValidatorReadinessState::SigningBlocked);
    assert_eq!(
        blocked.blocked_operations,
        vec!["checkpoint_submission[7]".to_owned()]
    );

    tokio::time::advance(Duration::from_secs(2)).await;
    task.await.expect("checkpoint submission should recover");
    assert_eq!(readiness.snapshot().state, ValidatorReadinessState::Ready);
}

#[tokio::test(start_paused = true)]
async fn missing_merkle_insertion_blocks_readiness_until_indexer_recovers() {
    let insertion = MerkleTreeInsertion::new(0, H256::random());
    let mut expected_tree = IncrementalMerkle::default();
    expected_tree.ingest(insertion.message_id());

    let db_calls = Arc::new(AtomicUsize::new(0));
    let mut db = MockDb::new();
    db.expect_retrieve_merkle_tree_insertion_by_leaf_index()
        .with(mockall::predicate::eq(0))
        .times(2)
        .returning({
            let db_calls = Arc::clone(&db_calls);
            move |_| {
                if db_calls.fetch_add(1, Ordering::SeqCst) == 0 {
                    Ok(None)
                } else {
                    Ok(Some(insertion))
                }
            }
        });

    let domain = dummy_domain(0, "dummy_domain");
    let mut merkle_tree_hook = MockMerkleTreeHook::new();
    merkle_tree_hook.expect_address().returning(H256::zero);
    merkle_tree_hook
        .expect_domain()
        .return_const(domain.clone());

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
        .with(mockall::predicate::eq(0))
        .once()
        .returning(|_| Ok(()));

    let readiness = Arc::new(ValidatorReadiness::default());
    let signer: Signers = ethers::signers::LocalWallet::new(&mut rand::thread_rng()).into();
    let submitter = ValidatorSubmitter::new(
        Duration::from_secs(1),
        ReorgPeriod::from_blocks(1),
        Arc::new(merkle_tree_hook),
        dummy_singleton_handle(),
        signer,
        Arc::new(checkpoint_syncer),
        Arc::new(db),
        dummy_metrics(),
        1,
        Some(Arc::new(MockReorgReporter::new())),
        Arc::clone(&readiness),
    );
    let correctness_checkpoint = CheckpointAtBlock {
        checkpoint: Checkpoint {
            root: expected_tree.root(),
            merkle_tree_hook_address: H256::zero(),
            mailbox_domain: domain.id(),
            index: 0,
        },
        block_height: Some(1),
    };

    let task = tokio::spawn(async move {
        submitter
            .submit_checkpoints_until_correctness_checkpoint(
                &mut IncrementalMerkle::default(),
                &correctness_checkpoint,
            )
            .await;
    });
    while db_calls.load(Ordering::SeqCst) == 0 {
        tokio::task::yield_now().await;
    }

    let blocked = readiness.snapshot();
    assert_eq!(blocked.state, ValidatorReadinessState::SigningBlocked);
    assert_eq!(
        blocked.blocked_operations,
        vec!["merkle_tree_insertion[0]".to_owned()]
    );

    tokio::time::advance(Duration::from_millis(100)).await;
    task.await.expect("checkpoint submission should recover");
    assert_eq!(readiness.snapshot().state, ValidatorReadinessState::Ready);
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
        dummy_singleton_handle(),
        signer,
        Arc::new(checkpoint_syncer),
        Arc::new(MockDb::new()),
        dummy_metrics(),
        1,
        Some(Arc::new(MockReorgReporter::new())),
        dummy_readiness(),
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
        dummy_singleton_handle(),
        signer,
        Arc::new(checkpoint_syncer),
        Arc::new(MockDb::new()),
        dummy_metrics(),
        1,
        Some(Arc::new(MockReorgReporter::new())),
        dummy_readiness(),
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
        dummy_singleton_handle(),
        signer,
        Arc::new(mock_checkpoint_syncer),
        Arc::new(MockDb::new()),
        dummy_metrics(),
        1,
        Some(Arc::new(mock_reorg_reporter)),
        dummy_readiness(),
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

/// Normal mode polls the configured hook directly, even with an unchanged tree.
/// Unexpected count reads or extra provider calls fail the mock.
#[tokio::test(start_paused = true)]
async fn checkpoint_submitter_checks_root_without_count_reads() {
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
        dummy_singleton_handle(),
        signer,
        Arc::new(MockCheckpointSyncer::new()),
        Arc::new(MockDb::new()),
        dummy_metrics(),
        1,
        Some(Arc::new(MockReorgReporter::new())),
        dummy_readiness(),
    );

    let task = tokio::spawn(async move {
        submitter.checkpoint_submitter(tree).await;
    });

    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_secs(1)).await;
    tokio::task::yield_now().await;
    assert!(!task.is_finished(), "unexpected RPC call or root mismatch");
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());

    assert!(
        latest_checkpoint_called.load(Ordering::SeqCst),
        "normal mode must check the root even without new leaves"
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
        dummy_singleton_handle(),
        signer,
        Arc::new(mock_checkpoint_syncer),
        Arc::new(db),
        dummy_metrics(),
        50,
        Some(Arc::new(mock_reorg_reporter)),
        dummy_readiness(),
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
        dummy_singleton_handle(),
        signer,
        Arc::new(mock_checkpoint_syncer),
        Arc::new(db),
        dummy_metrics(),
        50,
        Some(Arc::new(mock_reorg_reporter)),
        dummy_readiness(),
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
        dummy_singleton_handle(),
        signer,
        Arc::new(mock_checkpoint_syncer),
        Arc::new(db),
        dummy_metrics(),
        50,
        Some(Arc::new(mock_reorg_reporter)),
        dummy_readiness(),
    );

    // Start the submitter with an empty merkle tree, so it gets rebuilt from the db.
    // A panic is expected here, as the merkle root inconsistency is a critical error that may indicate fraud.
    let _ = validator_submitter
        .sign_and_submit_checkpoint(mock_onchain_checkpoint)
        .await;

    logs_contain("Checkpoint already submitted, but with different signature, overwriting");
}

fn snapshot_test_submitter(
    domain: HyperlaneDomain,
    signer: Signers,
    checkpoint_syncer: MockCheckpointSyncer,
    db: MockDb,
) -> ValidatorSubmitter {
    let mut merkle_tree_hook = MockMerkleTreeHook::new();
    merkle_tree_hook.expect_address().returning(H256::zero);
    merkle_tree_hook
        .expect_domain()
        .return_const(domain.clone());
    ValidatorSubmitter::new(
        Duration::from_secs(1),
        ReorgPeriod::from_blocks(1),
        Arc::new(merkle_tree_hook),
        dummy_singleton_handle(),
        signer,
        Arc::new(checkpoint_syncer),
        Arc::new(db),
        dummy_metrics(),
        50,
        Some(Arc::new(MockReorgReporter::new())),
        dummy_readiness(),
    )
}

fn three_leaf_snapshot_fixture() -> (
    HyperlaneDomain,
    Vec<MerkleTreeInsertion>,
    CheckpointWithMessageId,
    CheckpointAtBlock,
    MerkleTreeSnapshot,
) {
    let domain = dummy_domain(0, "dummy_domain");
    let insertions: Vec<MerkleTreeInsertion> = (0..3)
        .map(|i| MerkleTreeInsertion::new(i, H256::from_low_u64_be(11 * (i as u64 + 1))))
        .collect();

    let mut tree = IncrementalMerkle::default();
    for insertion in insertions.iter().take(2) {
        tree.ingest(insertion.message_id());
    }
    let checkpoint_at_snapshot = CheckpointWithMessageId {
        checkpoint: Checkpoint {
            root: tree.root(),
            merkle_tree_hook_address: H256::zero(),
            mailbox_domain: domain.id(),
            index: 1,
        },
        message_id: insertions[1].message_id(),
    };
    let snapshot = MerkleTreeSnapshot::capture(&tree).unwrap();
    tree.ingest(insertions[2].message_id());
    let target = CheckpointAtBlock {
        checkpoint: Checkpoint {
            root: tree.root(),
            merkle_tree_hook_address: H256::zero(),
            mailbox_domain: domain.id(),
            index: 2,
        },
        block_height: Some(1),
    };
    (domain, insertions, checkpoint_at_snapshot, target, snapshot)
}

#[tokio::test(start_paused = true)]
async fn backfill_restores_validated_snapshot_and_replays_tail() {
    let (domain, insertions, checkpoint_at_snapshot, target, snapshot) =
        three_leaf_snapshot_fixture();
    let signer: Signers = ethers::signers::LocalWallet::new(&mut rand::thread_rng()).into();
    let signed_at_snapshot = signer.sign(checkpoint_at_snapshot).await.unwrap();

    // Only the post-snapshot leaf is read from the local database.
    let mut db = MockDb::new();
    db.expect_retrieve_merkle_tree_insertion_by_leaf_index()
        .with(mockall::predicate::eq(2))
        .times(1)
        .returning(move |_| Ok(Some(insertions[2])));

    let mut checkpoint_syncer = MockCheckpointSyncer::new();
    checkpoint_syncer
        .expect_read_merkle_snapshot()
        .times(1)
        .return_once(move || Ok(Some(snapshot)));
    // One validation read for the snapshot, one fetch for the tail checkpoint.
    checkpoint_syncer
        .expect_fetch_checkpoint()
        .times(2)
        .returning(move |index| {
            if index == 1 {
                Ok(Some(signed_at_snapshot.clone()))
            } else {
                Ok(None)
            }
        });
    checkpoint_syncer
        .expect_write_checkpoint()
        .times(1)
        .returning(|_| Ok(()));
    checkpoint_syncer
        .expect_update_latest_index()
        .with(mockall::predicate::eq(2))
        .once()
        .returning(|_| Ok(()));
    // The completed tree is persisted for the next restart.
    checkpoint_syncer
        .expect_write_merkle_snapshot()
        .withf(|snapshot| snapshot.index == 2)
        .times(1)
        .returning(|_| Ok(()));

    let submitter = snapshot_test_submitter(domain, signer, checkpoint_syncer, db);
    let restored = submitter
        .restored_snapshot_tree(target.index)
        .await
        .unwrap_or_default();
    submitter
        .backfill_checkpoint_submitter(target, restored)
        .await;
}

#[tokio::test(start_paused = true)]
async fn backfill_progress_counts_published_checkpoints_not_reconstruction_or_retries() {
    let (domain, insertions, existing, target, _) = three_leaf_snapshot_fixture();
    let signer: Signers = ethers::signers::LocalWallet::new(&mut rand::thread_rng()).into();
    let existing = signer.sign(existing).await.unwrap();
    let metrics = dummy_metrics();
    metrics.merkle_tree_leaf_count.set(99);

    let observed = metrics.clone();
    let mut db = MockDb::new();
    db.expect_retrieve_merkle_tree_insertion_by_leaf_index()
        .times(3)
        .returning(move |index| {
            assert_eq!(observed.backfill_merkle_tree_leaf_count.get(), 0);
            assert_eq!(
                observed.historical_reconstruction_leaf_count.get(),
                i64::from(*index)
            );
            Ok(Some(insertions[*index as usize]))
        });
    let ready = Arc::new(AtomicBool::new(false));
    let attempts = Arc::new(AtomicUsize::new(0));
    let ready_for_write = ready.clone();
    let observed_attempts = attempts.clone();
    let mut syncer = MockCheckpointSyncer::new();
    syncer
        .expect_fetch_checkpoint()
        .returning(move |index| Ok((index == 1).then(|| existing.clone())));
    syncer
        .expect_write_checkpoint()
        .returning(move |checkpoint| {
            assert_ne!(
                checkpoint.value.index, 1,
                "existing checkpoint is not rewritten"
            );
            if checkpoint.value.index == 0 {
                observed_attempts.fetch_add(1, Ordering::SeqCst);
                if !ready_for_write.load(Ordering::SeqCst) {
                    return Err(eyre::eyre!("historical storage unavailable"));
                }
            }
            Ok(())
        });
    syncer
        .expect_update_latest_index()
        .with(mockall::predicate::eq(2))
        .once()
        .returning(|_| Ok(()));
    syncer
        .expect_write_merkle_snapshot()
        .withf(|snapshot| snapshot.index == 2)
        .once()
        .returning(|_| Ok(()));

    let mut submitter = snapshot_test_submitter(domain, signer, syncer, db);
    submitter.metrics = metrics.clone();
    let task =
        tokio::spawn(submitter.backfill_checkpoint_submitter(target, IncrementalMerkle::default()));
    for _ in 0..40 {
        tokio::time::advance(Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
    }
    assert!(attempts.load(Ordering::SeqCst) > 1);
    assert!(!task.is_finished());
    assert_eq!(metrics.backfill_merkle_tree_leaf_count.get(), 2);
    assert_eq!(metrics.merkle_tree_leaf_count.get(), 99);
    assert_eq!(metrics.historical_reconstruction_leaf_count.get(), 3);

    ready.store(true, Ordering::SeqCst);
    task.await.unwrap();
    assert_eq!(metrics.backfill_merkle_tree_leaf_count.get(), 3);
    assert_eq!(metrics.merkle_tree_leaf_count.get(), 99);
}

#[tokio::test(start_paused = true)]
async fn backfill_restores_snapshot_at_target_without_replay() {
    let (domain, _, checkpoint_at_snapshot, _, snapshot) = three_leaf_snapshot_fixture();
    let signer: Signers = ethers::signers::LocalWallet::new(&mut rand::thread_rng()).into();
    let target = CheckpointAtBlock {
        checkpoint: checkpoint_at_snapshot.checkpoint.clone(),
        block_height: Some(1),
    };
    let signed_at_snapshot = signer.sign(checkpoint_at_snapshot).await.unwrap();

    let db = MockDb::new();
    let mut checkpoint_syncer = MockCheckpointSyncer::new();
    checkpoint_syncer
        .expect_read_merkle_snapshot()
        .once()
        .return_once(move || Ok(Some(snapshot)));
    checkpoint_syncer
        .expect_fetch_checkpoint()
        .once()
        .return_once(move |_| Ok(Some(signed_at_snapshot)));
    checkpoint_syncer
        .expect_write_merkle_snapshot()
        .withf(|snapshot| snapshot.index == 1)
        .once()
        .returning(|_| Ok(()));

    let submitter = snapshot_test_submitter(domain, signer, checkpoint_syncer, db);
    let metrics = submitter.metrics.clone();
    let restored = submitter
        .restored_snapshot_tree(target.index)
        .await
        .unwrap_or_default();
    submitter
        .backfill_checkpoint_submitter(target, restored)
        .await;
    assert_eq!(metrics.backfill_merkle_tree_leaf_count.get(), 2);
    assert_eq!(metrics.merkle_tree_leaf_count.get(), 0);
    assert_eq!(metrics.historical_reconstruction_leaf_count.get(), 2);
}

#[tokio::test(start_paused = true)]
async fn backfill_rebuilds_tree_when_snapshot_is_corrupt() {
    let (_, _, _, _, mut snapshot) = three_leaf_snapshot_fixture();
    snapshot.root = H256::from_low_u64_be(0xdead);
    assert_backfill_rebuilds_tree(Ok(Some(snapshot))).await;
}

#[tokio::test(start_paused = true)]
async fn backfill_rebuilds_tree_when_snapshot_is_unavailable() {
    assert_backfill_rebuilds_tree(Ok(None)).await;
    assert_backfill_rebuilds_tree(Err(eyre::eyre!("Snapshot exceeds size limit"))).await;
}

async fn assert_backfill_rebuilds_tree(snapshot: Result<Option<MerkleTreeSnapshot>>) {
    let (domain, insertions, _, target, _) = three_leaf_snapshot_fixture();

    let mut db = MockDb::new();
    db.expect_retrieve_merkle_tree_insertion_by_leaf_index()
        .times(3)
        .returning(move |sequence| Ok(Some(insertions[*sequence as usize])));

    let mut checkpoint_syncer = MockCheckpointSyncer::new();
    checkpoint_syncer
        .expect_read_merkle_snapshot()
        .times(1)
        .return_once(move || snapshot);
    // No validation read happens without a usable snapshot; every checkpoint
    // is fetched and written as in a cold backfill.
    checkpoint_syncer
        .expect_fetch_checkpoint()
        .times(3)
        .returning(|_| Ok(None));
    checkpoint_syncer
        .expect_write_checkpoint()
        .times(3)
        .returning(|_| Ok(()));
    checkpoint_syncer
        .expect_update_latest_index()
        .with(mockall::predicate::eq(2))
        .once()
        .returning(|_| Ok(()));
    checkpoint_syncer
        .expect_write_merkle_snapshot()
        .withf(|snapshot| snapshot.index == 2)
        .times(1)
        .returning(|_| Ok(()));

    let signer: Signers = ethers::signers::LocalWallet::new(&mut rand::thread_rng()).into();
    let submitter = snapshot_test_submitter(domain, signer, checkpoint_syncer, db);
    let restored = submitter
        .restored_snapshot_tree(target.index)
        .await
        .unwrap_or_default();
    submitter
        .backfill_checkpoint_submitter(target, restored)
        .await;
}

#[tokio::test(start_paused = true)]
async fn normal_backfill_replays_skipped_history_after_snapshot_loss() {
    use hyperlane_base::db::{HyperlaneRocksDB, DB};

    use crate::merkle_tree_hook_sync::MerkleTreeHookWebSocketSync;

    for corrupt in [false, true] {
        let (domain, insertions, _, target, mut snapshot) = three_leaf_snapshot_fixture();
        let directory = tempfile::tempdir().expect("test database");
        let db = HyperlaneRocksDB::new(
            &domain,
            DB::from_path(directory.path()).expect("test database"),
        );
        let websocket = MerkleTreeHookWebSocketSync::new(
            db.clone(),
            domain.id(),
            H256::zero(),
            "ws://localhost:8080".parse().expect("test URL"),
            IntGauge::new("websocket", "test").expect("test gauge"),
            IntGauge::new("fallback", "test").expect("test gauge"),
            Arc::new(Notify::new()),
        );
        // A previous lightweight run skipped the prefix covered by its snapshot.
        assert_eq!(websocket.next_sequence_after_snapshot(2).unwrap(), 2);
        db.store_tree_insertion(&insertions[2], 1).unwrap();
        assert_eq!(websocket.next_sequence_after_snapshot(2).unwrap(), 3);

        snapshot.root = H256::repeat_byte(0xff);
        let mut syncer = MockCheckpointSyncer::new();
        syncer
            .expect_read_merkle_snapshot()
            .once()
            .return_once(move || Ok(corrupt.then_some(snapshot)));
        syncer
            .expect_fetch_checkpoint()
            .times(3)
            .returning(|_| Ok(None));
        let published = Arc::new(std::sync::Mutex::new(Vec::new()));
        let observed = published.clone();
        syncer
            .expect_write_checkpoint()
            .times(3)
            .returning(move |signed| {
                observed.lock().unwrap().push(signed.value.index);
                Ok(())
            });
        syncer
            .expect_update_latest_index()
            .with(mockall::predicate::eq(2))
            .once()
            .returning(|_| Ok(()));
        syncer
            .expect_write_merkle_snapshot()
            .withf(|snapshot| snapshot.index == 2)
            .once()
            .returning(|_| Ok(()));
        let signer: Signers = ethers::signers::LocalWallet::new(&mut rand::thread_rng()).into();
        let mut submitter = snapshot_test_submitter(domain, signer, syncer, MockDb::new());
        submitter.db = Arc::new(db.clone());

        // Normal-mode startup shares this single restore with replay and backfill.
        let tree = submitter
            .restored_snapshot_tree(target.index)
            .await
            .unwrap_or_default();
        let replay_from = websocket
            .next_sequence_after_snapshot(tree.count() as u32)
            .unwrap();
        assert_eq!(
            replay_from, 0,
            "must ignore the old cursor after snapshot loss"
        );
        for insertion in &insertions[replay_from as usize..2] {
            db.store_tree_insertion(insertion, 1).unwrap();
        }
        submitter.backfill_checkpoint_submitter(target, tree).await;
        let mut indices = published.lock().unwrap().clone();
        indices.sort_unstable();
        assert_eq!(indices, vec![0, 1, 2]);
    }
}

#[tokio::test]
async fn unchanged_tree_checkpoint_preserves_root_index_namespace_and_block() {
    for leaf_count in [1, 5] {
        let mut tree = IncrementalMerkle::default();
        for index in 0..leaf_count {
            tree.ingest(H256::from_low_u64_be(index + 1));
        }
        let expected = Checkpoint {
            root: tree.root(),
            index: tree.index(),
            merkle_tree_hook_address: H256::from_low_u64_be(123),
            mailbox_domain: 17,
        };
        let mut hook = MockMerkleTreeHook::new();
        hook.expect_address()
            .return_const(expected.merkle_tree_hook_address);
        hook.expect_domain()
            .return_const(dummy_domain(17, "root_reuse_domain"));
        let signer: Signers = ethers::signers::LocalWallet::new(&mut rand::thread_rng()).into();
        let submitter = ValidatorSubmitter::new(
            Duration::from_secs(1),
            ReorgPeriod::from_blocks(1),
            Arc::new(hook),
            dummy_singleton_handle(),
            signer,
            Arc::new(MockCheckpointSyncer::new()),
            Arc::new(MockDb::new()),
            dummy_metrics(),
            2,
            Some(Arc::new(MockReorgReporter::new())),
            dummy_readiness(),
        );
        let at_block = IncrementalMerkleAtBlock {
            tree: tree.clone(),
            block_height: Some(42),
        };
        let checkpoint = submitter.checkpoint_at_block(&at_block);
        assert_eq!(checkpoint.checkpoint, expected);
        assert_eq!(checkpoint.block_height, Some(42));
        // No DB reads, signing/storage calls, or reorg reports are expected when
        // the complete checkpoint already matches and no leaves are ingested.
        submitter
            .submit_checkpoints_until_correctness_checkpoint(&mut tree, &checkpoint)
            .await;
        assert_eq!(tree.root(), expected.root);
        assert_eq!(tree.index(), expected.index);
    }
}

#[tokio::test(start_paused = true)]
async fn latest_index_publication_reuses_submitter_handles_across_retries() {
    let attempts = Arc::new(AtomicUsize::new(0));
    let syncer = Arc::new_cyclic(|weak: &std::sync::Weak<MockCheckpointSyncer>| {
        let weak = weak.clone();
        let attempts = Arc::clone(&attempts);
        let mut syncer = MockCheckpointSyncer::new();
        syncer
            .expect_update_latest_index()
            .with(mockall::predicate::eq(8))
            .times(2)
            .returning(move |_| {
                assert_eq!(
                    weak.strong_count(),
                    1,
                    "publication must reuse the submitter, not clone its storage handle"
                );
                if attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                    Err(eyre::eyre!("latest index unavailable"))
                } else {
                    Ok(())
                }
            });
        syncer
    });
    let readiness = dummy_readiness();
    let mut submitter =
        submission_test_submitter(MockCheckpointSyncer::new(), Arc::clone(&readiness));
    submitter.checkpoint_syncer = syncer;
    let submitter = Arc::new(submitter);
    let start = tokio::time::Instant::now();
    submitter.publish_latest_checkpoint_index(8).await;
    assert_eq!(
        start.elapsed(),
        hyperlane_core::rpc_clients::RPC_RETRY_SLEEP_DURATION
    );
    assert_eq!(attempts.load(Ordering::SeqCst), 2);
    assert_eq!(Arc::strong_count(&submitter), 1);
    assert_eq!(readiness.snapshot().state, ValidatorReadinessState::Ready);
}

#[tokio::test(start_paused = true)]
async fn latest_index_publication_cancellation_stops_retry_and_releases_submitter() {
    let attempts = Arc::new(AtomicUsize::new(0));
    let mut syncer = MockCheckpointSyncer::new();
    syncer.expect_update_latest_index().once().returning({
        let attempts = Arc::clone(&attempts);
        move |_| {
            attempts.fetch_add(1, Ordering::SeqCst);
            Err(eyre::eyre!("latest index unavailable"))
        }
    });
    let readiness = dummy_readiness();
    let submitter = Arc::new(submission_test_submitter(syncer, Arc::clone(&readiness)));
    let task = tokio::spawn({
        let submitter = Arc::clone(&submitter);
        async move { submitter.publish_latest_checkpoint_index(8).await }
    });
    while attempts.load(Ordering::SeqCst) == 0 {
        tokio::task::yield_now().await;
    }
    assert_eq!(
        readiness.snapshot().blocked_operations,
        vec!["checkpoint_latest_index"]
    );
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert_eq!(Arc::strong_count(&submitter), 1);
    tokio::time::advance(hyperlane_core::rpc_clients::RPC_RETRY_SLEEP_DURATION).await;
    assert_eq!(attempts.load(Ordering::SeqCst), 1);
}

mockall::mock! {
    #[derive(Debug)]
    RecoveryIndexer {}

    #[async_trait]
    impl hyperlane_core::Indexer<MerkleTreeInsertion> for RecoveryIndexer {
        async fn fetch_logs_in_range(
            &self,
            range: std::ops::RangeInclusive<u32>,
        ) -> ChainResult<Vec<(hyperlane_core::Indexed<MerkleTreeInsertion>, hyperlane_core::LogMeta)>>;
        async fn get_finalized_block_number(&self) -> ChainResult<u32>;
    }

    #[async_trait]
    impl hyperlane_core::SequenceAwareIndexer<MerkleTreeInsertion> for RecoveryIndexer {
        async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)>;
    }
}

fn rpc_recovery_fixture(
    indexer: MockRecoveryIndexer,
) -> (MerkleTreeRpcRecovery, tempfile::TempDir) {
    use hyperlane_base::{
        db::{HyperlaneRocksDB, DB},
        settings::IndexSettings,
        ContractSyncMetrics,
    };
    let directory = tempfile::tempdir().expect("valid recovery test fixture");
    let domain = dummy_domain(0, "recovery");
    let db = HyperlaneRocksDB::new(
        &domain,
        DB::from_path(directory.path()).expect("valid recovery test fixture"),
    );
    let metrics =
        CoreMetrics::new("recovery", 0, Registry::new()).expect("valid recovery test fixture");
    let sync = hyperlane_base::SequencedDataContractSync::new(
        domain,
        Arc::new(db.clone()),
        Arc::new(indexer),
        ContractSyncMetrics::new(&metrics),
        false,
    );
    (
        MerkleTreeRpcRecovery {
            sync: Arc::new(sync),
            db,
            index_settings: IndexSettings {
                mode: hyperlane_core::IndexMode::Block,
                chunk_size: 1,
                ..Default::default()
            },
            from_block: Some(10),
        },
        directory,
    )
}

#[tokio::test]
async fn websocket_batches_only_fetch_rpc_logs_on_root_mismatch() {
    for (corrupt_stream, height) in [(false, Some(11)), (true, Some(11)), (true, None)] {
        let (domain, insertions, _, mut target, _) = three_leaf_snapshot_fixture();
        target.block_height = height;
        let mut indexer = MockRecoveryIndexer::new();
        if height.is_none() {
            indexer
                .expect_get_finalized_block_number()
                .once()
                .returning(|| Ok(11));
        }
        let recovered = Arc::new(AtomicBool::new(false));
        if corrupt_stream {
            let canonical = insertions.clone();
            let recovered = recovered.clone();
            indexer
                .expect_fetch_logs_in_range()
                .times(2)
                .returning(move |range| {
                    assert!(*range.start() >= 10 && *range.end() <= 11);
                    if *range.end() == 11 {
                        recovered.store(true, Ordering::SeqCst);
                    }
                    // Out-of-order logs and exact duplicates are valid RPC responses.
                    let mut logs: Vec<_> = canonical
                        .iter()
                        .rev()
                        .filter_map(|leaf| {
                            let block = 10 + leaf.index() / 2;
                            range.contains(&block).then_some((
                                (*leaf).into(),
                                hyperlane_core::LogMeta {
                                    block_number: u64::from(block),
                                    ..Default::default()
                                },
                            ))
                        })
                        .collect();
                    logs.push(logs[0].clone());
                    Ok(logs)
                });
        }
        // With a valid websocket batch, any indexer call fails this test.
        let (recovery, _directory) = rpc_recovery_fixture(indexer);
        for leaf in &insertions {
            let candidate = if corrupt_stream && leaf.index() == 1 {
                MerkleTreeInsertion::new(1, H256::repeat_byte(99))
            } else {
                *leaf
            };
            // Websocket block metadata is unauthenticated and cannot bound recovery.
            recovery
                .db
                .store_tree_insertion(&candidate, u64::MAX)
                .expect("valid recovery test fixture");
        }
        let mut expected_tree = IncrementalMerkle::default();
        let expected: Vec<_> = insertions
            .iter()
            .map(|leaf| {
                expected_tree.ingest(leaf.message_id());
                CheckpointWithMessageId {
                    checkpoint: Checkpoint {
                        root: expected_tree.root(),
                        index: leaf.index(),
                        ..target.checkpoint
                    },
                    message_id: leaf.message_id(),
                }
            })
            .collect();
        let mut syncer = MockCheckpointSyncer::new();
        syncer
            .expect_fetch_checkpoint()
            .times(3)
            .returning(|_| Ok(None));
        syncer
            .expect_write_checkpoint()
            .times(3)
            .returning(move |signed| {
                assert!(!corrupt_stream || recovered.load(Ordering::SeqCst));
                assert_eq!(
                    signed.value,
                    expected
                        [usize::try_from(signed.value.index).expect("valid recovery test fixture")]
                );
                Ok(())
            });
        syncer
            .expect_update_latest_index()
            .with(mockall::predicate::eq(2))
            .once()
            .returning(|_| Ok(()));
        let signer: Signers = ethers::signers::LocalWallet::new(&mut rand::thread_rng()).into();
        let mut submitter = snapshot_test_submitter(domain, signer, syncer, MockDb::new());
        submitter.db = Arc::new(recovery.db.clone());
        submitter = submitter.with_rpc_recovery(recovery.clone());
        let mut tree = IncrementalMerkle::default();
        submitter
            .submit_checkpoints_until_correctness_checkpoint(&mut tree, &target)
            .await;
        assert_eq!(tree.root(), target.root);
        for leaf in &insertions {
            assert_eq!(
                recovery
                    .db
                    .retrieve_merkle_tree_insertion_by_leaf_index(&leaf.index())
                    .expect("valid recovery test fixture"),
                Some(*leaf)
            );
        }
    }
}

#[tokio::test(start_paused = true)]
async fn tag_recovery_honors_configured_start_and_retries_only_failed_range() {
    for configured_start in [999_990, -10] {
        let (_, insertions, _, mut target, _) = three_leaf_snapshot_fixture();
        target.block_height = None;
        let mut indexer = MockRecoveryIndexer::new();
        indexer
            .expect_get_finalized_block_number()
            .once()
            .returning(|| Ok(1_000_000));
        let attempts = Arc::new(std::sync::Mutex::new(Vec::new()));
        let observed = attempts.clone();
        let leaves = insertions.clone();
        indexer
            .expect_fetch_logs_in_range()
            .times(4)
            .returning(move |range| {
                let mut attempts = observed.lock().expect("attempts");
                attempts.push(range.clone());
                if attempts.len() == 2 {
                    return Err(hyperlane_core::ChainCommunicationError::from_other_str(
                        "temporary failure",
                    ));
                }
                let index = if *range.start() == 999_990 {
                    0
                } else if *range.start() == 999_995 {
                    1
                } else {
                    2
                };
                Ok(vec![(
                    leaves[index].into(),
                    hyperlane_core::LogMeta {
                        block_number: u64::from(*range.start()),
                        ..Default::default()
                    },
                )])
            });
        let (mut recovery, _directory) = rpc_recovery_fixture(indexer);
        recovery.from_block = None;
        recovery.index_settings.from = configured_start;
        recovery.index_settings.chunk_size = 5;
        let recovered = recovery
            .fetch_insertions(0, &target)
            .await
            .expect("recovered batch");
        assert_eq!(recovered.len(), 3);
        assert_eq!(
            *attempts.lock().expect("attempts"),
            vec![
                999_990..=999_994,
                999_995..=999_999,
                999_995..=999_999,
                1_000_000..=1_000_000
            ]
        );
    }
}

#[tokio::test]
async fn rpc_recovery_rejects_incomplete_batch() {
    let (_, _, _, mut target, _) = three_leaf_snapshot_fixture();
    target.block_height = Some(10);
    let mut indexer = MockRecoveryIndexer::new();
    indexer
        .expect_fetch_logs_in_range()
        .once()
        .returning(|_| Ok(vec![]));
    let (recovery, _directory) = rpc_recovery_fixture(indexer);
    assert!(recovery
        .fetch_insertions(0, &target)
        .await
        .expect_err("incomplete batch must fail")
        .to_string()
        .contains("every insertion"));
}

#[tokio::test]
async fn rpc_recovery_cannot_sign_a_batch_that_still_mismatches() {
    use futures_util::FutureExt;
    for enable_recovery in [false, true] {
        let (domain, insertions, _, mut target, _) = three_leaf_snapshot_fixture();
        target.block_height = Some(10);
        target.checkpoint.root = H256::repeat_byte(99);
        let mut indexer = MockRecoveryIndexer::new();
        let rpc_leaves = insertions.clone();
        if enable_recovery {
            indexer
                .expect_fetch_logs_in_range()
                .once()
                .returning(move |_| {
                    Ok(rpc_leaves
                        .iter()
                        .map(|leaf| {
                            (
                                (*leaf).into(),
                                hyperlane_core::LogMeta {
                                    block_number: 10,
                                    ..Default::default()
                                },
                            )
                        })
                        .collect())
                });
        }
        let (recovery, _directory) = rpc_recovery_fixture(indexer);
        for leaf in &insertions {
            recovery
                .db
                .store_tree_insertion(leaf, 10)
                .expect("valid recovery test fixture");
        }
        // No checkpoint fetch, signature publication, or latest-index update is allowed.
        let mut syncer = MockCheckpointSyncer::new();
        syncer
            .expect_write_reorg_status()
            .once()
            .returning(|_| Ok(()));
        let mut reporter = MockReorgReporter::new();
        reporter
            .expect_report_at_block()
            .with(mockall::predicate::eq(10))
            .once()
            .returning(|_| ());
        let signer: Signers = ethers::signers::LocalWallet::new(&mut rand::thread_rng()).into();
        let mut submitter = snapshot_test_submitter(domain, signer, syncer, MockDb::new());
        submitter.db = Arc::new(recovery.db.clone());
        submitter.reorg_reporter = Some(Arc::new(reporter));
        if enable_recovery {
            submitter = submitter.with_rpc_recovery(recovery);
        }
        let mut tree = IncrementalMerkle::default();
        assert!(std::panic::AssertUnwindSafe(
            submitter.submit_checkpoints_until_correctness_checkpoint(&mut tree, &target)
        )
        .catch_unwind()
        .await
        .is_err());
    }
}

#[tokio::test]
async fn sequence_recovery_only_fetches_the_unverified_prefix() {
    let (_, insertions, _, mut target, _) = three_leaf_snapshot_fixture();
    target.block_height = None;
    let expected = insertions[1..].to_vec();
    let mut indexer = MockRecoveryIndexer::new();
    indexer
        .expect_fetch_logs_in_range()
        .times(2)
        .returning(move |range| {
            assert_eq!(range.start(), range.end());
            assert!(*range.start() >= 1 && *range.end() <= 2);
            Ok(vec![(
                insertions[usize::try_from(*range.start()).expect("leaf index")].into(),
                Default::default(),
            )])
        });
    let (mut recovery, _directory) = rpc_recovery_fixture(indexer);
    recovery.index_settings.mode = hyperlane_core::IndexMode::Sequence;
    let logs = recovery
        .fetch_insertions(1, &target)
        .await
        .expect("complete sequence range");
    assert_eq!(
        logs.iter()
            .map(|(leaf, _)| *leaf.inner())
            .collect::<Vec<_>>(),
        expected
    );
}

fn lightweight_checkpoints(count: u32) -> Vec<CheckpointAtBlock> {
    let mut tree = IncrementalMerkle::default();
    (0..count)
        .map(|index| {
            tree.ingest(H256::from_low_u64_be(u64::from(index) + 1));
            CheckpointAtBlock {
                checkpoint: Checkpoint {
                    root: tree.root(),
                    index,
                    merkle_tree_hook_address: H256::zero(),
                    mailbox_domain: 0,
                },
                block_height: None,
            }
        })
        .collect()
}

fn lightweight_test_submitter(
    available: Arc<AtomicUsize>,
    signed: Arc<std::sync::Mutex<Vec<u32>>>,
) -> ValidatorSubmitter {
    let mut hook = MockMerkleTreeHook::new();
    hook.expect_domain().return_const(dummy_domain(0, "test"));
    hook.expect_address().return_const(H256::zero());
    let mut db = MockDb::new();
    db.expect_retrieve_merkle_tree_insertion_by_leaf_index()
        .returning(move |index| {
            Ok(
                ((*index as usize) < available.load(Ordering::SeqCst)).then(|| {
                    MerkleTreeInsertion::new(*index, H256::from_low_u64_be(u64::from(*index) + 1))
                }),
            )
        });
    let mut syncer = MockCheckpointSyncer::new();
    syncer.expect_read_merkle_snapshot().returning(|| Ok(None));
    syncer.expect_write_merkle_snapshot().returning(|_| Ok(()));
    syncer.expect_fetch_checkpoint().returning(|_| Ok(None));
    syncer
        .expect_write_checkpoint()
        .returning(move |checkpoint| {
            signed.lock().unwrap().push(checkpoint.value.index);
            Ok(())
        });
    syncer.expect_update_latest_index().returning(|_| Ok(()));
    let mut submitter = dummy_submitter(Duration::from_secs(1));
    submitter.merkle_tree_hook = Arc::new(hook);
    submitter.db = Arc::new(db);
    submitter.checkpoint_syncer = Arc::new(syncer);
    submitter
}

#[test]
fn lightweight_large_replay_retains_only_sampled_frontiers() {
    let started = Instant::now();
    let mut tree = CheckpointTree::new(IncrementalMerkle::default());
    let indices = BTreeSet::from([0, 500_000, 999_999]);
    tree.prepare_samples(&indices);
    for index in 0..1_000_000_u32 {
        tree.ingest(
            H256::from_low_u64_be(u64::from(index)),
            indices.contains(&index),
        );
    }
    assert_eq!(tree.sampled.len(), 3);
    let expected = tree.accumulated.root();
    let latest = tree.commit(999_999).expect("latest checkpoint");
    assert_eq!(latest.root, expected);
    assert_eq!(tree.committed.root(), expected);
    assert!(
        tree.sampled.is_empty(),
        "no replay-sized allocation survives commit"
    );
    eprintln!(
        "Replayed one million insertions with three retained frontiers in {:?}",
        started.elapsed()
    );
}

#[tokio::test]
async fn lightweight_tree_progress_tracks_unverified_replay_and_live_updates() {
    let available = Arc::new(AtomicUsize::new(3));
    let submitter = lightweight_test_submitter(
        available.clone(),
        Arc::new(std::sync::Mutex::new(Vec::new())),
    );
    let checkpoints = lightweight_checkpoints(6);
    let mut tree = CheckpointTree::new(IncrementalMerkle::default());
    assert_eq!(submitter.metrics.merkle_tree_leaf_count.get(), 0);
    assert!(matches!(
        submitter
            .verify_checkpoint_batch(&mut tree, &[Some(checkpoints[4].clone())])
            .await,
        CheckpointBatch::WaitingForInsertions
    ));
    assert_eq!(submitter.metrics.merkle_tree_leaf_count.get(), 3);
    assert_eq!(
        tree.committed.count(),
        0,
        "reconstruction is not verification"
    );

    available.store(5, Ordering::SeqCst);
    assert!(matches!(
        submitter
            .verify_checkpoint_batch(
                &mut tree,
                &[Some(checkpoints[1].clone()), Some(checkpoints[4].clone())]
            )
            .await,
        CheckpointBatch::Verified { .. }
    ));
    assert_eq!(submitter.metrics.merkle_tree_leaf_count.get(), 5);
    assert_eq!(tree.committed.count(), 2, "slowest endpoint bounds signing");

    available.store(6, Ordering::SeqCst);
    assert!(matches!(
        submitter
            .verify_checkpoint_batch(&mut tree, &[Some(checkpoints[5].clone())])
            .await,
        CheckpointBatch::Verified { .. }
    ));
    assert_eq!(submitter.metrics.merkle_tree_leaf_count.get(), 6);
    assert_eq!(tree.committed.count(), 6);
    assert_eq!(submitter.metrics.backfill_merkle_tree_leaf_count.get(), 0);
}

#[tokio::test]
async fn merkle_reconstruction_exposes_progress_before_completion() {
    let count = 513;
    let checkpoints = lightweight_checkpoints(count);
    let target = checkpoints.last().expect("checkpoint fixture");
    let submitter = lightweight_test_submitter(
        Arc::new(AtomicUsize::new(count as usize)),
        Arc::new(std::sync::Mutex::new(Vec::new())),
    );
    for (lightweight, historical) in [(false, false), (true, false), (false, true)] {
        let mut submitter = submitter.clone();
        submitter.metrics.merkle_tree_leaf_count.set(0);
        let progress = if historical {
            submitter.start_historical_publication(&IncrementalMerkle::default());
            &submitter.metrics.historical_reconstruction_leaf_count
        } else {
            &submitter.metrics.merkle_tree_leaf_count
        };
        let ((), ()) = tokio::join!(
            biased;
            async {
                if lightweight {
                    let mut tree = CheckpointTree::new(IncrementalMerkle::default());
                    assert!(matches!(
                        submitter.verify_checkpoint_batch(&mut tree, &[Some(target.clone())]).await,
                        CheckpointBatch::Verified { .. }
                    ));
                    assert_eq!(tree.committed.root(), target.root);
                } else {
                    let mut tree = IncrementalMerkle::default();
                    let queue = submitter.verified_checkpoints(&mut tree, target).await;
                    assert_eq!(queue.len(), count as usize);
                    assert_eq!(tree.root(), target.root);
                }
            },
            async {
                // This task must run while reconstruction is still in progress,
                // just as the metrics server and socket heartbeat tasks must.
                let observed = progress.get();
                assert!(observed > 0 && observed < i64::from(count));
                assert_eq!(submitter.metrics.backfill_merkle_tree_leaf_count.get(), 0);
            }
        );
        assert_eq!(progress.get(), i64::from(count));
        if historical {
            assert_eq!(submitter.metrics.merkle_tree_leaf_count.get(), 0);
        }
    }
}

#[tokio::test(start_paused = true)]
async fn lightweight_different_indices_sign_through_two_thirds_supported_prefix() {
    let signed = Arc::new(std::sync::Mutex::new(Vec::new()));
    let submitter = lightweight_test_submitter(Arc::new(AtomicUsize::new(5)), signed.clone());
    let checkpoints = lightweight_checkpoints(5);
    let mut tree = IncrementalMerkle::default();
    // Deliberately unordered providers and duplicate indices.
    submitter
        .submit_lightweight_batch(
            &mut tree,
            vec![
                checkpoints[3].clone(),
                checkpoints[0].clone(),
                checkpoints[2].clone(),
                checkpoints[0].clone(),
            ],
        )
        .await;
    assert_eq!(tree.count(), 1);
    assert_eq!(*signed.lock().unwrap(), vec![0]);
    submitter
        .submit_lightweight_batch(
            &mut tree,
            vec![
                checkpoints[4].clone(),
                checkpoints[1].clone(),
                checkpoints[3].clone(),
            ],
        )
        .await;
    assert_eq!(tree.root(), checkpoints[3].root);
    assert_eq!(*signed.lock().unwrap(), vec![0, 3, 2, 1]);
}

#[tokio::test]
async fn lightweight_minority_cannot_veto_but_split_cannot_authorize_signing() {
    for mismatch in ["root", "domain", "hook"] {
        let checkpoints = lightweight_checkpoints(5);
        let mut bad = checkpoints[4].clone();
        match mismatch {
            "root" => bad.checkpoint.root = H256::zero(),
            "domain" => bad.checkpoint.mailbox_domain = 999,
            _ => bad.checkpoint.merkle_tree_hook_address = H256::from_low_u64_be(999),
        }
        for minority in [
            Some(bad.clone()),
            None,
            Some(lightweight_checkpoints(10).pop().expect("ahead checkpoint")),
        ] {
            let submitter = lightweight_test_submitter(
                Arc::new(AtomicUsize::new(5)),
                Arc::new(std::sync::Mutex::new(Vec::new())),
            );
            let mut tree = CheckpointTree::new(IncrementalMerkle::default());
            let batch = submitter
                .verify_checkpoint_batch(
                    &mut tree,
                    &[
                        Some(checkpoints[1].clone()),
                        minority,
                        Some(checkpoints[3].clone()),
                        Some(checkpoints[4].clone()),
                    ],
                )
                .await;
            let CheckpointBatch::Verified { checkpoint, latest } = batch else {
                panic!("three matching endpoints must authorize signing");
            };
            assert_eq!(checkpoint.index, 1);
            assert_eq!(latest.expect("new checkpoint").index, 1);
            assert!(!submitter.readiness.snapshot().signing_blocked);
        }

        let signed = Arc::new(std::sync::Mutex::new(Vec::new()));
        let submitter = lightweight_test_submitter(Arc::new(AtomicUsize::new(5)), signed.clone());
        let mut tree = IncrementalMerkle::default();
        submitter
            .submit_lightweight_batch(
                &mut tree,
                vec![
                    checkpoints[3].clone(),
                    checkpoints[4].clone(),
                    bad.clone(),
                    bad,
                ],
            )
            .await;
        assert!(signed.lock().expect("signatures").is_empty());
        assert_eq!(tree.count(), 0);
        assert!(submitter.readiness.snapshot().signing_blocked);
    }
}

#[tokio::test]
async fn lightweight_failed_endpoints_do_not_reduce_threshold() {
    let submitter = lightweight_test_submitter(
        Arc::new(AtomicUsize::new(5)),
        Arc::new(std::sync::Mutex::new(Vec::new())),
    );
    let checkpoints = lightweight_checkpoints(5);
    let mut tree = CheckpointTree::new(IncrementalMerkle::default());
    assert!(matches!(
        submitter
            .verify_checkpoint_batch(
                &mut tree,
                &[
                    Some(checkpoints[3].clone()),
                    None,
                    Some(checkpoints[4].clone()),
                    None,
                ]
            )
            .await,
        CheckpointBatch::WaitingForRpc
    ));
    assert_eq!(tree.committed.count(), 0);
    assert!(matches!(
        submitter
            .verify_checkpoint_batch(
                &mut tree,
                &[
                    Some(checkpoints[3].clone()),
                    Some(checkpoints[2].clone()),
                    Some(checkpoints[4].clone()),
                    None,
                ]
            )
            .await,
        CheckpointBatch::Verified { .. }
    ));
    assert_eq!(tree.committed.index(), 2);
}

#[tokio::test]
async fn lightweight_lagging_minority_does_not_block_progress() {
    let submitter = lightweight_test_submitter(
        Arc::new(AtomicUsize::new(5)),
        Arc::new(std::sync::Mutex::new(Vec::new())),
    );
    let checkpoints = lightweight_checkpoints(5);
    let mut tree = CheckpointTree::new(IncrementalMerkle::default());
    submitter
        .verify_checkpoint_batch(&mut tree, &[Some(checkpoints[2].clone())])
        .await;
    let batch = submitter
        .verify_checkpoint_batch(
            &mut tree,
            &[
                Some(checkpoints[0].clone()),
                Some(checkpoints[3].clone()),
                Some(checkpoints[4].clone()),
            ],
        )
        .await;
    let CheckpointBatch::Verified { checkpoint, .. } = batch else {
        panic!("two matching endpoints must advance past a lagging minority");
    };
    assert_eq!(checkpoint.index, 3);
    assert_eq!(tree.committed.index(), 3);
}

#[tokio::test(start_paused = true)]
async fn lightweight_provider_behind_signed_frontier_pauses_then_recovers() {
    let signed = Arc::new(std::sync::Mutex::new(Vec::new()));
    let submitter = lightweight_test_submitter(Arc::new(AtomicUsize::new(5)), signed.clone());
    let checkpoints = lightweight_checkpoints(5);
    let mut tree = IncrementalMerkle::default();
    submitter
        .submit_lightweight_batch(&mut tree, vec![checkpoints[2].clone()])
        .await;
    let before = signed.lock().unwrap().clone();
    submitter
        .submit_lightweight_batch(
            &mut tree,
            vec![checkpoints[0].clone(), checkpoints[4].clone()],
        )
        .await;
    assert_eq!(tree.root(), checkpoints[2].root);
    assert_eq!(*signed.lock().unwrap(), before);
    assert!(submitter.readiness.snapshot().signing_blocked);
    submitter
        .submit_lightweight_batch(
            &mut tree,
            vec![checkpoints[3].clone(), checkpoints[4].clone()],
        )
        .await;
    assert_eq!(tree.root(), checkpoints[3].root);
    assert_eq!(signed.lock().unwrap().last(), Some(&3));
    assert!(!submitter.readiness.snapshot().signing_blocked);
}

#[tokio::test(start_paused = true)]
async fn lightweight_waits_for_websocket_to_reach_every_captured_checkpoint() {
    let signed = Arc::new(std::sync::Mutex::new(Vec::new()));
    let available = Arc::new(AtomicUsize::new(1));
    let wake = Arc::new(Notify::new());
    let submitter = lightweight_test_submitter(available.clone(), signed.clone())
        .with_checkpoint_wake(Some(wake.clone()));
    let checkpoints = lightweight_checkpoints(3);
    let readiness = submitter.readiness.clone();
    let task = tokio::spawn(async move {
        let mut tree = IncrementalMerkle::default();
        submitter
            .submit_lightweight_batch(
                &mut tree,
                vec![checkpoints[0].clone(), checkpoints[2].clone()],
            )
            .await;
        tree
    });
    tokio::task::yield_now().await;
    assert!(!task.is_finished());
    assert!(signed.lock().unwrap().is_empty());
    assert!(readiness.snapshot().signing_blocked);
    available.store(3, Ordering::SeqCst);
    wake.notify_one();
    let tree = task.await.expect("websocket catchup resumes verification");
    assert_eq!(tree.count(), 1);
    assert_eq!(*signed.lock().unwrap(), vec![0]);
    assert!(!readiness.snapshot().signing_blocked);
}

#[tokio::test(start_paused = true)]
async fn lightweight_batches_insertions_with_one_checkpoint_read_and_no_idle_rpc_reads() {
    let signed = Arc::new(std::sync::Mutex::new(Vec::new()));
    let submitter = lightweight_test_submitter(Arc::new(AtomicUsize::new(3)), signed.clone());
    let checkpoint = lightweight_checkpoints(3).pop().unwrap();
    let mut hook = MockMerkleTreeHook::new();
    hook.expect_latest_checkpoint()
        .once()
        .return_once(move |_| Ok(checkpoint));
    let reader = Arc::new(
        CheckpointReader::new(CheckpointConsensus::Majority, vec![Arc::new(hook)])
            .expect("endpoint"),
    );
    let task = tokio::spawn(start_lightweight_submitter(submitter, reader));
    for _ in 0..10 {
        tokio::time::advance(Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
    }
    assert_eq!(*signed.lock().unwrap(), vec![2, 1, 0]);
    assert!(
        !task.is_finished(),
        "idle validator must not call unconfigured RPC methods"
    );
    task.abort();
    assert!(task.await.expect_err("cancelled loop").is_cancelled());
}

#[tokio::test(start_paused = true)]
async fn lightweight_empty_chain_waits_without_any_rpc_calls() {
    let signed = Arc::new(std::sync::Mutex::new(Vec::new()));
    let submitter = lightweight_test_submitter(Arc::new(AtomicUsize::new(0)), signed.clone());
    let reader = Arc::new(
        CheckpointReader::new(
            CheckpointConsensus::Majority,
            vec![Arc::new(MockMerkleTreeHook::new())],
        )
        .expect("endpoint"),
    );
    let task = tokio::spawn(start_lightweight_submitter(submitter, reader));
    for _ in 0..5 {
        tokio::time::advance(Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
    }
    assert!(!task.is_finished());
    assert!(signed.lock().unwrap().is_empty());
    task.abort();
    assert!(task.await.expect_err("cancelled loop").is_cancelled());
}

impl ValidatorSubmitter {
    async fn submit_lightweight_batch(
        &self,
        signed_tree: &mut IncrementalMerkle,
        checkpoints: Vec<CheckpointAtBlock>,
    ) {
        let checkpoints: Vec<_> = checkpoints.into_iter().map(Some).collect();
        let mut tree = CheckpointTree::new(signed_tree.clone());
        loop {
            match self.verify_checkpoint_batch(&mut tree, &checkpoints).await {
                CheckpointBatch::WaitingForInsertions => self.wait_for_checkpoint_check().await,
                CheckpointBatch::WaitingForRpc => return,
                CheckpointBatch::Verified { checkpoint, .. } => {
                    let queue = self.verified_checkpoints(signed_tree, &checkpoint).await;
                    self.sign_and_submit_checkpoints(
                        queue
                            .into_iter()
                            .map(|queued| queued.into_checkpoint(checkpoint.checkpoint)),
                    )
                    .await;
                    *signed_tree = tree.committed;
                    return;
                }
            }
        }
    }
}

#[tokio::test(start_paused = true)]
async fn lightweight_refresh_replaces_a_conflicting_checkpoint_even_when_rpc_advances() {
    let signed = Arc::new(std::sync::Mutex::new(Vec::new()));
    let submitter = lightweight_test_submitter(Arc::new(AtomicUsize::new(3)), signed.clone());
    let mut hooks: Vec<Arc<dyn MerkleTreeHook>> = Vec::new();
    for endpoint in 0..3 {
        let checkpoints = lightweight_checkpoints(11);
        let mut calls = 0_u32;
        let mut hook = MockMerkleTreeHook::new();
        hook.expect_latest_checkpoint().returning(move |_| {
            calls = calls.saturating_add(1);
            let checkpoint = match (endpoint, calls) {
                (0, 1) => {
                    let mut bad = checkpoints[1].clone();
                    bad.checkpoint.root = H256::zero();
                    bad
                }
                (1, 1) => checkpoints[0].clone(),
                (2, _) => checkpoints[10].clone(), // Minority remains ahead of replay.
                _ => checkpoints[2].clone(),
            };
            Ok(checkpoint)
        });
        hooks.push(Arc::new(hook));
    }
    let reader =
        Arc::new(CheckpointReader::new(CheckpointConsensus::Majority, hooks).expect("endpoints"));
    let task = tokio::spawn(start_lightweight_submitter(submitter, reader));
    for _ in 0..5 {
        tokio::time::advance(Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
    }
    assert!(signed.lock().expect("signatures").is_empty());
    for _ in 0..40 {
        tokio::time::advance(Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
    }
    let published = signed.lock().expect("signatures").clone();
    task.abort();
    assert!(task.await.expect_err("cancelled loop").is_cancelled());
    assert!(
        published.contains(&2),
        "recovered majority must replace the conflicting sample"
    );
}

#[tokio::test(start_paused = true)]
async fn lightweight_refreshes_ahead_checkpoint_when_websocket_progress_stalls() {
    let signed = Arc::new(std::sync::Mutex::new(Vec::new()));
    let submitter = lightweight_test_submitter(Arc::new(AtomicUsize::new(1)), signed.clone());
    let checkpoints = lightweight_checkpoints(3);
    let reads = Arc::new(AtomicUsize::new(0));
    let calls = reads.clone();
    let mut hook = MockMerkleTreeHook::new();
    hook.expect_latest_checkpoint()
        .times(2)
        .returning(move |_| {
            let index = if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                2
            } else {
                0
            };
            Ok(checkpoints[index].clone())
        });
    let reader = Arc::new(
        CheckpointReader::new(CheckpointConsensus::Majority, vec![Arc::new(hook)]).unwrap(),
    );
    let task = tokio::spawn(start_lightweight_submitter(submitter, reader));
    for _ in 0..5 {
        tokio::time::advance(Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
    }
    assert_eq!(reads.load(Ordering::SeqCst), 1);
    assert!(signed.lock().unwrap().is_empty());
    for _ in 0..40 {
        tokio::time::advance(Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
    }
    assert_eq!(reads.load(Ordering::SeqCst), 2);
    assert_eq!(*signed.lock().unwrap(), vec![0]);
    assert!(!task.is_finished());
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
}

#[tokio::test]
async fn lightweight_reconstructs_unsampled_indices_without_retaining_history() {
    let mut submitter = lightweight_test_submitter(
        Arc::new(AtomicUsize::new(5)),
        Arc::new(std::sync::Mutex::new(Vec::new())),
    );
    let mut db = MockDb::new();
    // Unsampled intermediate indices may be replayed from the committed frontier.
    for index in 0..5 {
        db.expect_retrieve_merkle_tree_insertion_by_leaf_index()
            .with(mockall::predicate::eq(index))
            .returning(move |_| {
                Ok(Some(MerkleTreeInsertion::new(
                    index,
                    H256::from_low_u64_be(u64::from(index) + 1),
                )))
            });
    }
    submitter.db = Arc::new(db);
    let checkpoints = lightweight_checkpoints(5);
    let mut tree = CheckpointTree::new(IncrementalMerkle::default());
    for (slow_index, expected_queue) in [(0, 1), (0, 0), (2, 2), (4, 2)] {
        let batch = submitter
            .verify_checkpoint_batch(
                &mut tree,
                &[
                    Some(checkpoints[slow_index].clone()),
                    Some(checkpoints[4].clone()),
                ],
            )
            .await;
        let CheckpointBatch::Verified { latest, .. } = batch else {
            panic!("verified batch");
        };
        assert_eq!(latest.is_some(), expected_queue > 0);
        assert_eq!(tree.committed.index(), slow_index as u32);
        assert_eq!(tree.committed.root(), checkpoints[slow_index].root);
    }
    assert!(tree.sampled.is_empty());
}

#[tokio::test(start_paused = true)]
async fn lightweight_restores_signed_snapshot_without_republishing_history() {
    let (domain, insertions, checkpoint_at_snapshot, target, snapshot) =
        three_leaf_snapshot_fixture();
    let signer: Signers = ethers::signers::LocalWallet::new(&mut rand::thread_rng()).into();
    let signed_at_snapshot = signer.sign(checkpoint_at_snapshot).await.unwrap();
    let mut db = MockDb::new();
    db.expect_retrieve_merkle_tree_insertion_by_leaf_index()
        .returning(move |index| match index {
            2 => Ok(Some(insertions[2])),
            3 => Ok(None),
            _ => panic!("must not replay pre-snapshot leaves"),
        });
    let mut syncer = MockCheckpointSyncer::new();
    syncer
        .expect_read_merkle_snapshot()
        .once()
        .return_once(move || Ok(Some(snapshot)));
    syncer
        .expect_fetch_checkpoint()
        .times(2)
        .returning(move |index| match index {
            1 => Ok(Some(signed_at_snapshot.clone())),
            2 => Ok(None),
            _ => panic!("must not fetch pre-snapshot checkpoints"),
        });
    let published = Arc::new(AtomicBool::new(false));
    let wrote = published.clone();
    syncer
        .expect_write_checkpoint()
        .once()
        .returning(move |checkpoint| {
            assert_eq!(checkpoint.value.index, 2);
            wrote.store(true, Ordering::SeqCst);
            Ok(())
        });
    syncer
        .expect_update_latest_index()
        .with(mockall::predicate::eq(2))
        .once()
        .returning(|_| Ok(()));
    syncer
        .expect_write_merkle_snapshot()
        .withf(|snapshot| snapshot.index == 2)
        .once()
        .returning(|_| Ok(()));
    let submitter = snapshot_test_submitter(domain, signer, syncer, db);
    let mut hook = MockMerkleTreeHook::new();
    hook.expect_latest_checkpoint()
        .once()
        .return_once(move |_| Ok(target));
    let reader = Arc::new(
        CheckpointReader::new(CheckpointConsensus::Majority, vec![Arc::new(hook)]).unwrap(),
    );
    let task = tokio::spawn(start_lightweight_submitter(submitter, reader));
    for _ in 0..10 {
        tokio::time::advance(Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
    }
    assert!(published.load(Ordering::SeqCst));
    assert!(!task.is_finished());
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
}

#[tokio::test(start_paused = true)]
async fn lightweight_live_signing_continues_while_history_uploads_retry() {
    let available = Arc::new(AtomicUsize::new(3));
    let signed = Arc::new(std::sync::Mutex::new(Vec::new()));
    let mut submitter = lightweight_test_submitter(available.clone(), signed.clone());
    let history_ready = Arc::new(AtomicBool::new(false));
    let ready = history_ready.clone();
    let observed = signed.clone();
    let mut syncer = MockCheckpointSyncer::new();
    syncer
        .expect_read_merkle_snapshot()
        .once()
        .returning(|| Ok(None));
    syncer.expect_fetch_checkpoint().returning(|_| Ok(None));
    syncer
        .expect_write_checkpoint()
        .returning(move |checkpoint| {
            if checkpoint.value.index < 2 && !ready.load(Ordering::SeqCst) {
                return Err(eyre::eyre!("historical object unavailable"));
            }
            observed.lock().unwrap().push(checkpoint.value.index);
            Ok(())
        });
    // Historical uploads must never write the latest-index pointer.
    syncer
        .expect_update_latest_index()
        .withf(|index| *index >= 2)
        .times(2)
        .returning(|_| Ok(()));
    let snapshots = Arc::new(std::sync::Mutex::new(Vec::new()));
    let stored = snapshots.clone();
    syncer
        .expect_write_merkle_snapshot()
        .returning(move |snapshot| {
            stored.lock().unwrap().push(snapshot.index);
            Ok(())
        });
    submitter.checkpoint_syncer = Arc::new(syncer);
    let checkpoints = lightweight_checkpoints(4);
    let indexed = available.clone();
    let mut hook = MockMerkleTreeHook::new();
    hook.expect_latest_checkpoint()
        .times(2)
        .returning(move |_| Ok(checkpoints[indexed.load(Ordering::SeqCst) - 1].clone()));
    let reader = Arc::new(
        CheckpointReader::new(CheckpointConsensus::Majority, vec![Arc::new(hook)]).unwrap(),
    );
    let task = tokio::spawn(start_lightweight_submitter(submitter, reader));
    for _ in 0..10 {
        tokio::time::advance(Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
    }
    assert_eq!(*signed.lock().unwrap(), vec![2]);
    available.store(4, Ordering::SeqCst);
    for _ in 0..10 {
        tokio::time::advance(Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
    }
    assert_eq!(*signed.lock().unwrap(), vec![2, 3]);
    assert!(
        snapshots.lock().unwrap().is_empty(),
        "snapshot must not skip unpublished history"
    );
    history_ready.store(true, Ordering::SeqCst);
    for _ in 0..40 {
        tokio::time::advance(Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
    }
    let mut all_signed = signed.lock().unwrap().clone();
    all_signed.sort_unstable();
    assert_eq!(all_signed, vec![0, 1, 2, 3]);
    assert_eq!(*snapshots.lock().unwrap(), vec![2, 3]);
    assert!(!task.is_finished());
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
}

#[tokio::test(start_paused = true)]
async fn lightweight_later_history_stalls_do_not_block_live_signing_or_skip_snapshots() {
    let available = Arc::new(AtomicUsize::new(1));
    let signed = Arc::new(std::sync::Mutex::new(Vec::new()));
    let mut submitter = lightweight_test_submitter(available.clone(), signed.clone());
    let metrics = submitter.metrics.clone();
    let history_ready = Arc::new(AtomicBool::new(false));
    let durable = Arc::new(std::sync::Mutex::new(std::collections::BTreeMap::<
        u32,
        SignedCheckpointWithMessageId,
    >::new()));
    let mut syncer = MockCheckpointSyncer::new();
    syncer
        .expect_read_merkle_snapshot()
        .once()
        .returning(|| Ok(None));
    let stored = durable.clone();
    syncer
        .expect_fetch_checkpoint()
        .returning(move |index| Ok(stored.lock().unwrap().get(&index).cloned()));
    let stored = durable.clone();
    let ready = history_ready.clone();
    let observed = signed.clone();
    syncer
        .expect_write_checkpoint()
        .returning(move |checkpoint| {
            let index = checkpoint.value.index;
            if index == 1 && !ready.load(Ordering::SeqCst) {
                return Err(eyre::eyre!("historical object unavailable"));
            }
            assert!(stored
                .lock()
                .unwrap()
                .insert(index, checkpoint.clone())
                .is_none());
            observed.lock().unwrap().push(index);
            Ok(())
        });
    let latest = Arc::new(std::sync::Mutex::new(Vec::new()));
    let observed = latest.clone();
    syncer.expect_update_latest_index().returning(move |index| {
        observed.lock().unwrap().push(index);
        Ok(())
    });
    let snapshots = Arc::new(std::sync::Mutex::new(Vec::new()));
    let observed = snapshots.clone();
    let stored = durable.clone();
    syncer
        .expect_write_merkle_snapshot()
        .returning(move |snapshot| {
            let stored = stored.lock().unwrap();
            assert!((0..=snapshot.index).all(|index| stored.contains_key(&index)));
            observed.lock().unwrap().push(snapshot.index);
            Ok(())
        });
    submitter.checkpoint_syncer = Arc::new(syncer);
    let checkpoints = lightweight_checkpoints(6);
    let indexed = available.clone();
    let mut hook = MockMerkleTreeHook::new();
    hook.expect_latest_checkpoint()
        .times(4)
        .returning(move |_| Ok(checkpoints[indexed.load(Ordering::SeqCst) - 1].clone()));
    let reader = Arc::new(
        CheckpointReader::new(CheckpointConsensus::Majority, vec![Arc::new(hook)]).unwrap(),
    );
    let task = tokio::spawn(start_lightweight_submitter(submitter, reader));
    // Complete the first batch, then stall history in the second while two more arrive.
    for count in [1, 3, 4, 6] {
        available.store(count, Ordering::SeqCst);
        for _ in 0..10 {
            tokio::time::advance(Duration::from_secs(1)).await;
            tokio::task::yield_now().await;
        }
        assert!(durable.lock().unwrap().contains_key(&(count as u32 - 1)));
        assert_eq!(*snapshots.lock().unwrap(), vec![0]);
    }
    assert_eq!(*signed.lock().unwrap(), vec![0, 2, 3, 5]);
    assert_eq!(metrics.merkle_tree_leaf_count.get(), 6);
    assert_eq!(metrics.backfill_merkle_tree_leaf_count.get(), 2);
    history_ready.store(true, Ordering::SeqCst);
    for _ in 0..40 {
        tokio::time::advance(Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
    }
    assert_eq!(
        durable.lock().unwrap().keys().copied().collect::<Vec<_>>(),
        vec![0, 1, 2, 3, 4, 5]
    );
    assert_eq!(*latest.lock().unwrap(), vec![0, 2, 3, 5]);
    assert_eq!(*snapshots.lock().unwrap(), vec![0, 2, 5]);
    assert_eq!(metrics.merkle_tree_leaf_count.get(), 6);
    assert_eq!(metrics.backfill_merkle_tree_leaf_count.get(), 6);
    assert!(!task.is_finished());
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
}

#[tokio::test(start_paused = true)]
async fn lightweight_refreshes_ahead_checkpoint_during_continuous_websocket_progress() {
    let available = Arc::new(AtomicUsize::new(1));
    let signed = Arc::new(std::sync::Mutex::new(Vec::new()));
    let submitter = lightweight_test_submitter(available.clone(), signed.clone());
    let checkpoints = lightweight_checkpoints(1001);
    let reads = Arc::new(AtomicUsize::new(0));
    let calls = reads.clone();
    let indexed = available.clone();
    let mut hook = MockMerkleTreeHook::new();
    hook.expect_latest_checkpoint().returning(move |_| {
        let index = if calls.fetch_add(1, Ordering::SeqCst) == 0 {
            1000 // Transiently incorrect ahead response; subsequent reads recover.
        } else {
            indexed.load(Ordering::SeqCst) - 1
        };
        Ok(checkpoints[index].clone())
    });
    let reader = Arc::new(
        CheckpointReader::new(CheckpointConsensus::Majority, vec![Arc::new(hook)]).unwrap(),
    );
    let task = tokio::spawn(start_lightweight_submitter(submitter, reader));
    tokio::task::yield_now().await;
    for count in 2..=51 {
        // Progress every second must not extend the captured sample's lifetime.
        available.store(count, Ordering::SeqCst);
        tokio::time::advance(Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
    }
    assert!(
        reads.load(Ordering::SeqCst) >= 2,
        "must refresh despite continuous progress"
    );
    assert!(
        signed.lock().unwrap().iter().any(|index| *index >= 30),
        "must resume live signing"
    );
    assert!(!task.is_finished());
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
}

#[tokio::test(start_paused = true)]
async fn lightweight_refresh_preserves_reachable_targets_during_slow_replay() {
    let available = Arc::new(AtomicUsize::new(1));
    let signed = Arc::new(std::sync::Mutex::new(Vec::new()));
    let submitter = lightweight_test_submitter(available.clone(), signed.clone());
    let checkpoints = lightweight_checkpoints(200);
    let indexed = available.clone();
    let reads = Arc::new(AtomicUsize::new(0));
    let calls = reads.clone();
    let mut hook = MockMerkleTreeHook::new();
    hook.expect_latest_checkpoint().returning(move |_| {
        calls.fetch_add(1, Ordering::SeqCst);
        // The chain is consistently 45 insertions ahead of websocket delivery.
        Ok(checkpoints[indexed.load(Ordering::SeqCst) + 44].clone())
    });
    let reader = Arc::new(
        CheckpointReader::new(CheckpointConsensus::Majority, vec![Arc::new(hook)]).unwrap(),
    );
    let task = tokio::spawn(start_lightweight_submitter(submitter, reader));
    tokio::task::yield_now().await;
    for count in 2..=61 {
        available.store(count, Ordering::SeqCst);
        tokio::time::advance(Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
    }
    assert!(
        reads.load(Ordering::SeqCst) >= 2,
        "periodic endpoint refresh"
    );
    assert!(
        signed.lock().unwrap().contains(&45),
        "replay must reach the original target despite an advancing tip"
    );
    assert!(!task.is_finished());
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
}

// Mirror production startup: authenticate once, then pass that same tree to signing.
async fn start_lightweight_submitter(submitter: ValidatorSubmitter, reader: Arc<CheckpointReader>) {
    let tree = submitter.restore_consensus_tree().await;
    submitter.consensus_checkpoint_submitter(reader, tree).await;
}

#[tokio::test(start_paused = true)]
async fn lightweight_websocket_wakes_cannot_accelerate_rpc_retries() {
    for failing in [false, true] {
        let signed = Arc::new(std::sync::Mutex::new(Vec::new()));
        let wake = Arc::new(Notify::new());
        let available = Arc::new(AtomicUsize::new(2));
        let submitter = lightweight_test_submitter(available, signed.clone())
            .with_checkpoint_wake(Some(wake.clone()));
        let reads = Arc::new(AtomicUsize::new(0));
        let calls = reads.clone();
        let checkpoint = lightweight_checkpoints(1).pop().expect("test fixture");
        let mut hook = MockMerkleTreeHook::new();
        hook.expect_latest_checkpoint().returning(move |_| {
            calls.fetch_add(1, Ordering::SeqCst);
            if failing {
                Err(hyperlane_core::ChainCommunicationError::from_other_str(
                    "rate limited",
                ))
            } else {
                Ok(checkpoint.clone()) // Confirmed chain tip has not advanced.
            }
        });
        let reader = Arc::new(
            CheckpointReader::new(CheckpointConsensus::Majority, vec![Arc::new(hook)])
                .expect("test fixture"),
        );
        let task = tokio::spawn(start_lightweight_submitter(submitter, reader));
        tokio::task::yield_now().await;
        let started = tokio::time::Instant::now();
        for _ in 0..100 {
            wake.notify_one();
            tokio::task::yield_now().await;
        }
        assert_eq!(started.elapsed(), Duration::ZERO);
        assert_eq!(reads.load(Ordering::SeqCst), 1);
        tokio::time::advance(Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
        assert_eq!(reads.load(Ordering::SeqCst), 2);
        assert_eq!(
            *signed.lock().expect("test fixture"),
            if failing { vec![] } else { vec![0] }
        );
        task.abort();
        assert!(task.await.expect_err("cancelled loop").is_cancelled());
    }
}

#[tokio::test]
async fn consensus_votes_at_each_leaf_index_without_historical_rpc_queries() {
    for (policy, expected_index) in [
        (CheckpointConsensus::Quorum, 4),
        (CheckpointConsensus::Majority, 1),
    ] {
        let mut submitter = lightweight_test_submitter(
            Arc::new(AtomicUsize::new(6)),
            Arc::new(std::sync::Mutex::new(Vec::new())),
        );
        submitter.checkpoint_consensus = policy;
        let checkpoints = lightweight_checkpoints(6);
        let samples: Vec<_> = [0, 1, 4, 5]
            .map(|index| {
                let mut checkpoint = checkpoints[index].clone();
                checkpoint.block_height = None;
                Some(checkpoint)
            })
            .into();
        let mut tree = CheckpointTree::new(IncrementalMerkle::default());
        let CheckpointBatch::Verified { checkpoint, latest } =
            submitter.verify_checkpoint_batch(&mut tree, &samples).await
        else {
            panic!("different checkpoint indices must agree on a common prefix");
        };
        assert_eq!(checkpoint.index, expected_index);
        assert_eq!(latest.expect("new checkpoint").index, expected_index);
    }
}

#[tokio::test]
async fn quorum_allows_half_but_majority_blocks_split_or_failed_pool() {
    for policy in [CheckpointConsensus::Quorum, CheckpointConsensus::Majority] {
        for failures in [false, true] {
            let mut submitter = lightweight_test_submitter(
                Arc::new(AtomicUsize::new(3)),
                Arc::new(std::sync::Mutex::new(Vec::new())),
            );
            submitter.checkpoint_consensus = policy;
            let checkpoints = lightweight_checkpoints(3);
            let mut conflicting = checkpoints[2].clone();
            conflicting.checkpoint.root = H256::from_low_u64_be(999);
            let minority = if failures { None } else { Some(conflicting) };
            let samples = [
                Some(checkpoints[1].clone()),
                Some(checkpoints[2].clone()),
                minority.clone(),
                minority,
            ];
            let mut tree = CheckpointTree::new(IncrementalMerkle::default());
            let batch = submitter.verify_checkpoint_batch(&mut tree, &samples).await;
            if policy == CheckpointConsensus::Quorum {
                assert!(matches!(batch, CheckpointBatch::Verified { .. }));
                assert_eq!(tree.committed.index(), 1);
            } else {
                assert!(matches!(batch, CheckpointBatch::WaitingForRpc));
                assert_eq!(tree.committed.count(), 0);
            }
        }
    }
}

#[tokio::test]
async fn normal_consensus_recovery_requires_votes_before_repairing_or_signing() {
    for policy in [CheckpointConsensus::Quorum, CheckpointConsensus::Majority] {
        let required = policy.required(4);
        for matching in [required - 1, required] {
            let mut indexer = MockRecoveryIndexer::new();
            indexer
                .expect_fetch_logs_in_range()
                .once()
                .returning(|range| {
                    assert_eq!(range, 0..=2);
                    Ok((0..3)
                        .map(|index| {
                            (
                                MerkleTreeInsertion::new(
                                    index,
                                    H256::from_low_u64_be(u64::from(index) + 1),
                                )
                                .into(),
                                hyperlane_core::LogMeta::default(),
                            )
                        })
                        .collect())
                });
            let (mut recovery, _directory) = rpc_recovery_fixture(indexer);
            recovery.index_settings.mode = hyperlane_core::IndexMode::Sequence;
            recovery.index_settings.chunk_size = 10;
            for index in 0..3 {
                recovery
                    .db
                    .store_tree_insertion(
                        &MerkleTreeInsertion::new(index, H256::from_low_u64_be(999)),
                        0,
                    )
                    .unwrap();
            }
            let signed = Arc::new(std::sync::Mutex::new(Vec::new()));
            let mut submitter =
                lightweight_test_submitter(Arc::new(AtomicUsize::new(3)), signed.clone());
            submitter.db = Arc::new(recovery.db.clone());
            submitter = submitter.with_rpc_recovery(recovery);
            submitter.checkpoint_consensus = policy;
            let checkpoints = lightweight_checkpoints(3);
            let samples: Vec<_> = (0..4)
                .map(|i| {
                    let mut checkpoint = checkpoints[if i == 0 { 1 } else { 2 }].clone();
                    if i >= matching {
                        checkpoint.checkpoint.root = H256::from_low_u64_be(777);
                    }
                    // Neither this height nor a single matching root can authorize a repair.
                    checkpoint.block_height = Some(u64::MAX);
                    Some(checkpoint)
                })
                .collect();
            let mut tree = CheckpointTree::new(IncrementalMerkle::default());
            assert!(matches!(
                submitter.verify_checkpoint_batch(&mut tree, &samples).await,
                CheckpointBatch::WaitingForRpc
            ));
            let result = submitter
                .recover_checkpoint_batch(&mut tree, &samples)
                .await;
            if matching == required {
                let Some(CheckpointBatch::Verified { checkpoint, latest }) = result else {
                    panic!("recovery must reach configured agreement");
                };
                assert_eq!(checkpoint.index, 1);
                for index in 0..2 {
                    assert_eq!(
                        submitter
                            .db
                            .retrieve_merkle_tree_insertion_by_leaf_index(&index)
                            .unwrap()
                            .unwrap()
                            .message_id(),
                        H256::from_low_u64_be(u64::from(index) + 1)
                    );
                }
                // Index 2 was fetched but lies beyond the authenticated signing boundary.
                assert_eq!(
                    submitter
                        .db
                        .retrieve_merkle_tree_insertion_by_leaf_index(&2)
                        .unwrap()
                        .unwrap()
                        .message_id(),
                    H256::from_low_u64_be(999)
                );
                submitter
                    .sign_and_submit_checkpoints(std::iter::once(
                        latest.unwrap().into_checkpoint(checkpoint.checkpoint),
                    ))
                    .await;
                assert_eq!(*signed.lock().unwrap(), vec![1]);
                assert_eq!(tree.accumulated.count(), 2);
            } else {
                assert!(result.is_none());
                assert_eq!(tree.committed.count(), 0);
                assert!(signed.lock().unwrap().is_empty());
                assert_eq!(
                    submitter
                        .db
                        .retrieve_merkle_tree_insertion_by_leaf_index(&0)
                        .unwrap()
                        .unwrap()
                        .message_id(),
                    H256::from_low_u64_be(999)
                );
            }
        }
    }
}

#[tokio::test(start_paused = true)]
async fn normal_consensus_retains_idle_checkpoint_polling() {
    let calls = Arc::new(AtomicUsize::new(0));
    let observed = calls.clone();
    let checkpoint = lightweight_checkpoints(1).pop().unwrap();
    let mut hook = MockMerkleTreeHook::new();
    hook.expect_latest_checkpoint().returning(move |_| {
        observed.fetch_add(1, Ordering::SeqCst);
        Ok(checkpoint.clone())
    });
    let reader =
        Arc::new(CheckpointReader::new(CheckpointConsensus::Quorum, vec![Arc::new(hook)]).unwrap());
    let (recovery, _directory) = rpc_recovery_fixture(MockRecoveryIndexer::new());
    let submitter = lightweight_test_submitter(
        Arc::new(AtomicUsize::new(1)),
        Arc::new(std::sync::Mutex::new(Vec::new())),
    )
    .with_rpc_recovery(recovery);
    let task = tokio::spawn(start_lightweight_submitter(submitter, reader));
    for _ in 0..10 {
        tokio::time::advance(Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
    }
    assert!(
        calls.load(Ordering::SeqCst) > 1,
        "normal mode polls even after signing the only insertion"
    );
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
}
