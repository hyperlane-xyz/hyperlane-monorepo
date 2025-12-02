use std::{fmt::Debug, sync::Arc, time::Duration};

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
#[should_panic(
    expected = "Incorrect tree root. Most likely a reorg has occurred. Please reach out for help, this is a potentially serious error impacting signed messages. Do NOT forcefully resume operation of this validator. Keep it crashlooping or shut down until you receive support."
)]
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
