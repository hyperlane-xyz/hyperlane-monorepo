// This file can be placed at agents/validator/src/submit_test.rs
// Or its contents can be placed inside a `mod test` block in agents/validator/src/submit.rs

use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use ethers::signers::LocalWallet;
use mockall::mock;
use prometheus::Registry;

use hyperlane_base::db::{DbResult, HyperlaneDb};
use hyperlane_base::{CheckpointSyncer, CoreMetrics, ReorgReporter};
use hyperlane_core::{
    ChainResult, Checkpoint, CheckpointWithMessageId, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneMessage, HyperlaneProvider, HyperlaneSigner, HyperlaneSignerExt,
    MerkleTreeHook, ReorgEvent, ReorgPeriod, SignedAnnouncement, SignedCheckpointWithMessageId,
    H160, H256,
};
use hyperlane_ethereum::{Signers, SingletonSignerHandle};

use crate::submit::{ValidatorSubmitter, ValidatorSubmitterMetrics};

// --- MOCK DEFINITIONS ---
// We need to create mock objects for all the `dyn Trait` dependencies
// that ValidatorSubmitter requires.

mock! {
    pub Db {}
    // We only implement the methods needed to satisfy the compiler
    // for creating the Arc<dyn HyperlaneDb>. The test itself won't call any of these.
    #[allow(dead_code, unused_variables)]
    impl HyperlaneDb for Db {
        fn retrieve_highest_seen_message_nonce(&self) -> DbResult<Option<u32>> { todo!() }
        fn retrieve_message_by_nonce(&self, nonce: u32) -> DbResult<Option<HyperlaneMessage>> { todo!() }
        fn retrieve_processed_by_nonce(&self, nonce: &u32) -> DbResult<Option<bool>> { todo!() }
        fn domain(&self) -> &HyperlaneDomain { todo!() }
        // Add other methods with `todo!()` if the compiler requires them.
        // ...
    }
}

mock! {
    pub MerkleTreeHook {}
    impl HyperlaneContract for MerkleTreeHook {
        fn address(&self) -> H256 { H256::default() }
    }
    impl HyperlaneChain for MerkleTreeHook {
        fn domain(&self) -> &HyperlaneDomain { unimplemented!() }
        fn provider(&self) -> Box<dyn HyperlaneProvider> { unimplemented!() }
    }
    // No methods from the MerkleTreeHook trait itself are called in sign_checkpoint,
    // so we don't need to mock them.
    #[async_trait]
    impl MerkleTreeHook for MerkleTreeHook {}
}

mock! {
    pub CheckpointSyncer {}
    impl std::fmt::Debug for CheckpointSyncer {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "MockCheckpointSyncer")
        }
    }
    // No methods from the CheckpointSyncer trait are called in sign_checkpoint.
    #[async_trait]
    impl CheckpointSyncer for CheckpointSyncer {
        async fn latest_index(&self) -> eyre::Result<Option<u32>> { todo!() }
        async fn write_latest_index(&self, index: u32) -> eyre::Result<()> { todo!() }
        async fn fetch_checkpoint(&self, index: u32) -> eyre::Result<Option<SignedCheckpointWithMessageId>> { todo!() }
        async fn write_checkpoint(&self, signed_checkpoint: &SignedCheckpointWithMessageId) -> eyre::Result<()> { todo!() }
        async fn write_metadata(&self, serialized_metadata: &str) -> eyre::Result<()> { todo!() }
        async fn write_announcement(&self, signed_announcement: &SignedAnnouncement) -> eyre::Result<()> { todo!() }
        fn announcement_location(&self) -> String { todo!() }
        async fn write_reorg_status(&self, reorg_event: &ReorgEvent) -> eyre::Result<()> { todo!() }
        async fn reorg_status(&self) -> eyre::Result<Option<ReorgEvent>> { todo!() }
    }
}

mock! {
    pub ReorgReporter {}
    impl std::fmt::Debug for ReorgReporter {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "MockReorgReporter")
        }
    }
    // No methods from this trait are called in sign_checkpoint.
    #[async_trait]
    impl ReorgReporter for ReorgReporter {}
}

// --- HELPER FUNCTIONS ---

/// Creates a dummy `ValidatorSubmitterMetrics` for testing.
fn dummy_metrics() -> ValidatorSubmitterMetrics {
    let core_metrics = CoreMetrics::new("test_validator", 9999, Registry::new()).unwrap();
    ValidatorSubmitterMetrics::new(&core_metrics, &HyperlaneDomain::new_test_domain("test"))
}

/// Creates a dummy `CheckpointWithMessageId` for testing.
fn dummy_checkpoint() -> CheckpointWithMessageId {
    CheckpointWithMessageId {
        checkpoint: Checkpoint {
            merkle_tree_hook_address: H256::random(),
            mailbox_domain: 1,
            root: H256::random(),
            index: 1,
        },
        message_id: H256::random(),
    }
}

/// The actual test for the `sign_checkpoint` function.
#[tokio::test]
async fn test_sign_checkpoint_succeeds_with_real_signer() {
    // ======== 1. ARRANGE ========

    // --- Create the real signer object ---
    // This is a deterministic, hardcoded private key.
    let private_key = "1111111111111111111111111111111111111111111111111111111111111111";
    let wallet = LocalWallet::from_str(private_key).unwrap();
    let signer_address: H160 = wallet.address();
    let signer = Signers::Local(wallet);

    // --- Create mock objects for all other dependencies ---
    let mock_merkle_tree_hook = Arc::new(MockMerkleTreeHook::new());
    let mock_checkpoint_syncer = Arc::new(MockCheckpointSyncer::new());
    let mock_db = Arc::new(MockDb::new());
    let mock_reorg_reporter = Arc::new(MockReorgReporter::new());

    // --- Create a dummy SingletonSignerHandle ---
    // The test won't use the fallback, so the channel can be immediately dropped.
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let singleton_signer = SingletonSignerHandle::new(H160::random(), tx);

    // --- Instantiate the ValidatorSubmitter with the real signer and mocks ---
    let submitter = ValidatorSubmitter::new(
        Duration::from_secs(5),
        ReorgPeriod::from_blocks(10),
        mock_merkle_tree_hook,
        singleton_signer,
        signer, // The real signer object
        mock_checkpoint_syncer,
        mock_db,
        dummy_metrics(),
        50, // max_sign_concurrency
        mock_reorg_reporter,
    );

    // --- Create the data to be signed ---
    let checkpoint_to_sign = dummy_checkpoint_with_message_id();

    // ======== 2. ACT ========

    // Call the function we want to test.
    let signed_checkpoint_result = submitter.sign_checkpoint(checkpoint_to_sign).await;

    // ======== 3. ASSERT ========

    // Check that the call was successful.
    assert!(
        signed_checkpoint_result.is_ok(),
        "Signing failed when it should have succeeded"
    );
    let signed_checkpoint = signed_checkpoint_result.unwrap();

    // Verify that the original value is preserved.
    assert_eq!(signed_checkpoint.value, checkpoint_to_sign);

    // Verify that the signature is valid and was produced by our signer.
    // This is the most important check.
    let verification_result = signed_checkpoint.verify(signer_address);
    assert!(verification_result.is_ok(), "Signature verification failed");
}

/*
Needs to work with https://github.com/dymensionxyz/hyperlane-cosmos/blob/7e116f7ab4f43865d01423d7474988d23e69e380/x/core/01_interchain_security/types/message_id_multisig_raw.go#L103-L113
See also https://github.com/dymensionxyz/hyperlane-monorepo/blob/d8f826ac813fe6a92279f8631ad57ce8e91a73a8/rust/main/agents/validator/src/submit.rs#L300-L303 for usual signing
https://github.com/dymensionxyz/hyperlane-monorepo/blob/00b8642100af822767ceb605bc2627de7ddde610/rust/main/hyperlane-core/src/types/checkpoint.rs#L32-L51
 */

fn dummy_checkpoint_with_message_id() -> CheckpointWithMessageId {
    let check = Checkpoint {
        merkle_tree_hook_address: H256::random(),
        mailbox_domain: 1,
        root: H256::random(),
        index: 1,
    };
    CheckpointWithMessageId {
        checkpoint: check,
        message_id: H256::random(),
    }
}