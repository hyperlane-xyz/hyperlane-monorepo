use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
};

use eyre::Result;

use hyperlane_core::{
    CheckpointWithMessageId, HyperlaneSignerExt, MultisigSignedCheckpoint, ReorgEvent,
    SignedAnnouncement, SignedCheckpointWithMessageId, H160,
};
use hyperlane_ethereum::Signers;

use crate::CheckpointSyncer;

type ResponseList<T> = Arc<Mutex<VecDeque<T>>>;

/// MockCheckpointSyncer responses
#[derive(Clone, Debug, Default)]
pub struct MockCheckpointSyncerResponses {
    /// responses for latest_index
    pub latest_index: ResponseList<Result<Option<u32>>>,
    /// responses for write_latest_index
    pub write_latest_index: ResponseList<Result<()>>,
    /// responses for fetch_checkpoint
    pub fetch_checkpoint: ResponseList<Result<Option<SignedCheckpointWithMessageId>>>,
    /// responses for write_checkpoint
    pub write_checkpoint: ResponseList<Result<()>>,
    /// responses for write_metadata
    pub write_metadata: ResponseList<Result<()>>,
    /// responses for write_announcement
    pub write_announcement: ResponseList<Result<()>>,
    /// responses for announcement_location
    pub announcement_location: ResponseList<String>,
    /// responses for write_reorg_status
    pub write_reorg_status: ResponseList<Result<()>>,
    /// responses for reorg_status
    pub reorg_status: ResponseList<Result<Option<ReorgEvent>>>,
}

/// MockCheckpointSyncer
#[derive(Clone, Debug, Default)]
pub struct MockCheckpointSyncer {
    /// MockCheckpointSyncer responses
    pub responses: MockCheckpointSyncerResponses,
}

impl MockCheckpointSyncer {
    /// constructor
    pub fn new() -> Self {
        Self {
            responses: MockCheckpointSyncerResponses::default(),
        }
    }
}

#[async_trait::async_trait]
impl CheckpointSyncer for MockCheckpointSyncer {
    async fn latest_index(&self) -> Result<Option<u32>> {
        self.responses
            .latest_index
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| panic!("No mock latest_index response set"))
    }

    async fn write_latest_index(&self, _: u32) -> Result<()> {
        self.responses
            .write_latest_index
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| panic!("No mock write_latest_index response set"))
    }

    async fn fetch_checkpoint(&self, _: u32) -> Result<Option<SignedCheckpointWithMessageId>> {
        self.responses
            .fetch_checkpoint
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| panic!("No mock fetch_checkpoint response set"))
    }

    async fn write_checkpoint(&self, _: &SignedCheckpointWithMessageId) -> Result<()> {
        self.responses
            .write_checkpoint
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| panic!("No mock write_checkpoint response set"))
    }

    async fn write_metadata(&self, _: &str) -> Result<()> {
        self.responses
            .write_metadata
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| panic!("No mock write_metadata response set"))
    }

    async fn write_announcement(&self, _: &SignedAnnouncement) -> Result<()> {
        self.responses
            .write_announcement
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| panic!("No mock write_announcement response set"))
    }

    fn announcement_location(&self) -> String {
        self.responses
            .announcement_location
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| panic!("No mock announcement_location response set"))
    }

    async fn write_reorg_status(&self, _: &ReorgEvent) -> Result<()> {
        self.responses
            .write_reorg_status
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| panic!("No mock write_reorg_status response set"))
    }

    async fn reorg_status(&self) -> Result<Option<ReorgEvent>> {
        self.responses
            .reorg_status
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| panic!("No mock reorg_status response set"))
    }
}

/// parameters for a validator for creating a mock checkpoint syncer
#[derive(Clone, Debug)]
pub struct TestValidator {
    /// private key
    pub private_key: String,
    /// public key
    pub public_key: H160,
    /// latest index response
    pub latest_index: Option<u32>,
    /// fetch checkpoint response
    pub fetch_checkpoint: Option<CheckpointWithMessageId>,
}

/// Generate a hashmap of mock checkpoint syncers
pub async fn build_mock_checkpoint_syncs(
    validators: &[TestValidator],
) -> HashMap<H160, MockCheckpointSyncer> {
    let mut syncers: HashMap<_, _> = HashMap::new();
    for validator in validators {
        let signer: Signers = validator
            .private_key
            .parse::<ethers::signers::LocalWallet>()
            .unwrap()
            .into();
        let syncer = MockCheckpointSyncer::new();
        syncer
            .responses
            .latest_index
            .lock()
            .unwrap()
            .push_back(Ok(validator.latest_index));

        let sig = match validator.fetch_checkpoint {
            Some(checkpoint) => Ok(Some(signer.sign(checkpoint).await.unwrap())),
            None => Ok(None),
        };
        syncer
            .responses
            .fetch_checkpoint
            .lock()
            .unwrap()
            .push_back(sig);
        let key = validator.public_key;
        let val = syncer;
        syncers.insert(key, val);
    }
    syncers
}

/// Generate a a multisig signed checkpoint
pub async fn generate_multisig_signed_checkpoint(
    validators: &[TestValidator],
    checkpoint: CheckpointWithMessageId,
) -> MultisigSignedCheckpoint {
    let mut signatures = Vec::new();
    for validator in validators.iter().filter(|v| v.fetch_checkpoint.is_some()) {
        let signer: Signers = validator
            .private_key
            .parse::<ethers::signers::LocalWallet>()
            .unwrap()
            .into();
        let sig = signer.sign(checkpoint).await.unwrap();
        signatures.push(sig.signature);
    }

    MultisigSignedCheckpoint {
        checkpoint,
        signatures,
    }
}
