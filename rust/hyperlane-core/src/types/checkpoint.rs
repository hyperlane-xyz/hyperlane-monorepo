use derive_more::Deref;
use ethers_core::types::{Address, Signature};
use serde::{Deserialize, Serialize};
use sha3::{digest::Update, Digest, Keccak256};
use std::fmt::Debug;

use crate::{utils::domain_hash, Signable, SignedType, H256};

/// An Hyperlane checkpoint
#[derive(Copy, Clone, Eq, PartialEq, Serialize, Deserialize, Debug)]
pub struct Checkpoint {
    /// The mailbox address
    pub mailbox_address: H256,
    /// The mailbox chain
    pub mailbox_domain: u32,
    /// The checkpointed root
    pub root: H256,
    /// The index of the checkpoint
    pub index: u32,
}

/// A Hyperlane (checkpoint, messageId) tuple
#[derive(Copy, Clone, Eq, PartialEq, Serialize, Deserialize, Debug, Deref)]
pub struct CheckpointWithMessageId {
    /// existing Hyperlane checkpoint struct
    #[deref]
    pub checkpoint: Checkpoint,
    /// hash of message emitted from mailbox checkpoint.index
    pub message_id: H256,
}

impl Signable for Checkpoint {
    /// A hash of the checkpoint contents.
    /// The EIP-191 compliant version of this hash is signed by validators.
    fn signing_hash(&self) -> H256 {
        // sign:
        // domain_hash(mailbox_address, mailbox_domain) || root || index (as u32)
        H256::from_slice(
            Keccak256::new()
                .chain(domain_hash(self.mailbox_address, self.mailbox_domain))
                .chain(self.root)
                .chain(self.index.to_be_bytes())
                .finalize()
                .as_slice(),
        )
    }
}

impl Signable for CheckpointWithMessageId {
    /// A hash of the checkpoint contents.
    /// The EIP-191 compliant version of this hash is signed by validators.
    fn signing_hash(&self) -> H256 {
        // sign:
        // domain_hash(mailbox_address, mailbox_domain) || root || index (as u32) || message_id
        H256::from_slice(
            Keccak256::new()
                .chain(domain_hash(self.mailbox_address, self.mailbox_domain))
                .chain(self.root)
                .chain(self.index.to_be_bytes())
                .chain(self.message_id)
                .finalize()
                .as_slice(),
        )
    }
}

/// Signed checkpoint
pub type SignedCheckpoint = SignedType<Checkpoint>;
/// Signed (checkpoint, messageId) tuple
pub type SignedCheckpointWithMessageId = SignedType<CheckpointWithMessageId>;

/// An individual signed checkpoint with the recovered signer
#[derive(Clone, Debug)]
pub struct SignedCheckpointWithSigner<T: Signable> {
    /// The recovered signer
    pub signer: Address,
    /// The signed checkpoint
    pub signed_checkpoint: SignedType<T>,
}

/// A signature and its signer.
#[derive(Clone, Debug)]
pub struct SignatureWithSigner {
    /// The signature
    pub signature: Signature,
    /// The signer of the signature
    pub signer: Address,
}

/// A checkpoint and multiple signatures
#[derive(Clone, Debug)]
pub struct MultisigSignedCheckpoint<T> {
    /// The checkpoint
    pub checkpoint: T,
    /// Signatures over the checkpoint. No ordering guarantees.
    pub signatures: Vec<SignatureWithSigner>,
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

impl<T: Signable + Eq + Copy> TryFrom<&Vec<SignedCheckpointWithSigner<T>>>
    for MultisigSignedCheckpoint<T>
{
    type Error = MultisigSignedCheckpointError;

    /// Given multiple signed checkpoints with their signer, creates a
    /// MultisigSignedCheckpoint
    fn try_from(
        signed_checkpoints: &Vec<SignedCheckpointWithSigner<T>>,
    ) -> Result<Self, Self::Error> {
        if signed_checkpoints.is_empty() {
            return Err(MultisigSignedCheckpointError::EmptySignatures());
        }
        // Get the first checkpoint and ensure all other signed checkpoints are for
        // the same checkpoint
        let checkpoint = signed_checkpoints[0].signed_checkpoint.value;
        if !signed_checkpoints
            .iter()
            .all(|c| checkpoint == c.signed_checkpoint.value)
        {
            return Err(MultisigSignedCheckpointError::InconsistentCheckpoints());
        }

        let signatures = signed_checkpoints
            .iter()
            .map(|c: &SignedCheckpointWithSigner<T>| SignatureWithSigner {
                signature: c.signed_checkpoint.signature,
                signer: c.signer,
            })
            .collect();

        Ok(MultisigSignedCheckpoint {
            checkpoint,
            signatures,
        })
    }
}
