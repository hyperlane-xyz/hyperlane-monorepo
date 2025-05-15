use std::fmt::Debug;

use derive_more::Deref;
use serde::{Deserialize, Serialize};
use sha3::{digest::Update, Digest, Keccak256};

use crate::{utils::domain_hash, Signable, Signature, SignedType, H256};

/// An Hyperlane checkpoint
#[derive(Copy, Clone, Serialize, Deserialize, Debug)]
pub struct Checkpoint {
    /// The merkle tree hook address
    pub merkle_tree_hook_address: H256,
    /// The mailbox / merkle tree hook domain
    pub mailbox_domain: u32,
    /// The checkpointed root
    pub root: H256,
    /// The index of the checkpoint
    pub index: u32,
    /// The block height of the checkpoint
    /// This field is not serialized and not signed
    #[serde(skip)]
    pub block_height: u64,
}

impl PartialEq for Checkpoint {
    fn eq(&self, other: &Self) -> bool {
        self.merkle_tree_hook_address == other.merkle_tree_hook_address
            && self.mailbox_domain == other.mailbox_domain
            && self.root == other.root
            && self.index == other.index
    }
}

impl Eq for Checkpoint {}

/// A Hyperlane (checkpoint, messageId) tuple
#[derive(Copy, Clone, Eq, PartialEq, Serialize, Deserialize, Debug, Deref)]
pub struct CheckpointWithMessageId {
    /// existing Hyperlane checkpoint struct
    #[deref]
    pub checkpoint: Checkpoint,
    /// hash of message emitted from mailbox checkpoint.index
    pub message_id: H256,
}

impl Signable for CheckpointWithMessageId {
    /// A hash of the checkpoint contents.
    /// The EIP-191 compliant version of this hash is signed by validators.
    fn signing_hash(&self) -> H256 {
        // sign:
        // domain_hash(mailbox_address, mailbox_domain) || root || index (as u32) || message_id
        H256::from_slice(
            Keccak256::new()
                .chain(domain_hash(
                    self.merkle_tree_hook_address,
                    self.mailbox_domain,
                ))
                .chain(self.root)
                .chain(self.index.to_be_bytes())
                .chain(self.message_id)
                .finalize()
                .as_slice(),
        )
    }
}

/// Signed (checkpoint, messageId) tuple
pub type SignedCheckpointWithMessageId = SignedType<CheckpointWithMessageId>;

/// A checkpoint and multiple signatures
#[derive(Clone, Debug)]
pub struct MultisigSignedCheckpoint {
    /// The checkpoint
    pub checkpoint: CheckpointWithMessageId,
    /// Signatures over the checkpoint ordered by validator index, length == threshold
    pub signatures: Vec<Signature>,
}

/// Error types for MultisigSignedCheckpoint
#[derive(Debug, thiserror::Error)]
pub enum MultisigSignedCheckpointError {
    /// The signed checkpoint's signatures are over inconsistent checkpoints
    #[error("Multisig signed checkpoint is for inconsistent checkpoints")]
    InconsistentCheckpoints(),
    /// The signed checkpoint has no signatures
    #[error("Multisig signed checkpoint has no signatures")]
    EmptySignatures(),
}

impl TryFrom<&mut Vec<SignedCheckpointWithMessageId>> for MultisigSignedCheckpoint {
    type Error = MultisigSignedCheckpointError;

    /// Given multiple signed checkpoints, create a MultisigSignedCheckpoint
    fn try_from(
        signed_checkpoints: &mut Vec<SignedCheckpointWithMessageId>,
    ) -> Result<Self, Self::Error> {
        if signed_checkpoints.is_empty() {
            return Err(MultisigSignedCheckpointError::EmptySignatures());
        }
        // Get the first checkpoint and ensure all other signed checkpoints are for
        // the same checkpoint
        let checkpoint = signed_checkpoints[0].value;
        if !signed_checkpoints.iter().all(|c| checkpoint == c.value) {
            return Err(MultisigSignedCheckpointError::InconsistentCheckpoints());
        }

        let signatures = signed_checkpoints.iter().map(|c| c.signature).collect();

        Ok(MultisigSignedCheckpoint {
            checkpoint,
            signatures,
        })
    }
}
