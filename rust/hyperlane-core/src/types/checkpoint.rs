use async_trait::async_trait;
use ethers_core::types::{Address, Signature};
use serde::{Deserialize, Serialize};
use sha3::{digest::Update, Digest, Keccak256};
use std::fmt::{Debug, Formatter};

use crate::utils::{fmt_address_for_domain, fmt_domain};
use crate::{utils::domain_hash, Signable, SignedType, H256};

/// An Hyperlane checkpoint
#[derive(Copy, Clone, Eq, PartialEq, Serialize, Deserialize)]
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

impl Debug for Checkpoint {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Checkpoint {{ mailbox_address: {}, mailbox_domain: {}, root: {:?}, index: {} }}",
            fmt_address_for_domain(self.mailbox_domain, self.mailbox_address),
            fmt_domain(self.mailbox_domain),
            self.root,
            self.index
        )
    }
}

#[async_trait]
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

/// A checkpoint that has been signed.
pub type SignedCheckpoint = SignedType<Checkpoint>;

/// An individual signed checkpoint with the recovered signer
#[derive(Clone, Debug)]
pub struct SignedCheckpointWithSigner {
    /// The recovered signer
    pub signer: Address,
    /// The signed checkpoint
    pub signed_checkpoint: SignedCheckpoint,
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
#[derive(Clone)]
pub struct MultisigSignedCheckpoint {
    /// The checkpoint
    pub checkpoint: Checkpoint,
    /// Signatures over the checkpoint. No ordering guarantees.
    pub signatures: Vec<SignatureWithSigner>,
}

impl Debug for MultisigSignedCheckpoint {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "MultisigSignedCheckpoint {{ checkpoint: {:?}, signature_count: {} }}",
            self.checkpoint,
            self.signatures.len()
        )
    }
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

impl TryFrom<&Vec<SignedCheckpointWithSigner>> for MultisigSignedCheckpoint {
    type Error = MultisigSignedCheckpointError;

    /// Given multiple signed checkpoints with their signer, creates a
    /// MultisigSignedCheckpoint
    fn try_from(signed_checkpoints: &Vec<SignedCheckpointWithSigner>) -> Result<Self, Self::Error> {
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
            .map(|c| SignatureWithSigner {
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
