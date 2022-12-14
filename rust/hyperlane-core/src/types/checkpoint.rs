use ethers::{
    prelude::{Address, Signature},
    utils::hash_message,
};
use ethers_signers::Signer;
use serde::{Deserialize, Serialize};
use sha3::{Digest, Keccak256};

use crate::{utils::domain_hash, Decode, Encode, HyperlaneProtocolError, SignerExt, H256};

/// An Hyperlane checkpoint
#[derive(Copy, Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
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

impl std::fmt::Display for Checkpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Checkpoint(domain {} moved from {} to {})",
            self.mailbox_domain, self.root, self.index
        )
    }
}

impl Encode for Checkpoint {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: std::io::Write,
    {
        writer.write_all(self.mailbox_address.as_ref())?;
        writer.write_all(&self.mailbox_domain.to_be_bytes())?;
        writer.write_all(self.root.as_ref())?;
        writer.write_all(&self.index.to_be_bytes())?;
        Ok(32 + 4 + 32 + 4)
    }
}

impl Decode for Checkpoint {
    fn read_from<R>(reader: &mut R) -> Result<Self, HyperlaneProtocolError>
    where
        R: std::io::Read,
        Self: Sized,
    {
        let mut mailbox_address = H256::zero();
        reader.read_exact(mailbox_address.as_mut())?;

        let mut mailbox_domain = [0u8; 4];
        reader.read_exact(&mut mailbox_domain)?;

        let mut root = H256::zero();
        reader.read_exact(root.as_mut())?;

        let mut index = [0u8; 4];
        reader.read_exact(&mut index)?;

        Ok(Self {
            mailbox_address,
            mailbox_domain: u32::from_be_bytes(mailbox_domain),
            root,
            index: u32::from_be_bytes(index),
        })
    }
}

impl Checkpoint {
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

    fn prepended_hash(&self) -> H256 {
        hash_message(self.signing_hash())
    }

    /// Sign an checkpoint using the specified signer
    pub async fn sign_with<S: Signer>(self, signer: &S) -> Result<SignedCheckpoint, S::Error> {
        let signature = signer
            .sign_message_without_eip_155(self.signing_hash())
            .await?;
        Ok(SignedCheckpoint {
            checkpoint: self,
            signature,
        })
    }
}

/// A Signed Hyperlane checkpoint
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SignedCheckpoint {
    /// The checkpoint
    pub checkpoint: Checkpoint,
    /// The signature
    pub signature: Signature,
}

impl Encode for SignedCheckpoint {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: std::io::Write,
    {
        let mut written = 0;
        written += self.checkpoint.write_to(writer)?;
        written += self.signature.write_to(writer)?;
        Ok(written)
    }
}

impl Decode for SignedCheckpoint {
    fn read_from<R>(reader: &mut R) -> Result<Self, HyperlaneProtocolError>
    where
        R: std::io::Read,
        Self: Sized,
    {
        let checkpoint = Checkpoint::read_from(reader)?;
        let signature = Signature::read_from(reader)?;
        Ok(Self {
            checkpoint,
            signature,
        })
    }
}

impl SignedCheckpoint {
    /// Recover the Ethereum address of the signer
    pub fn recover(&self) -> Result<Address, HyperlaneProtocolError> {
        Ok(self.signature.recover(self.checkpoint.prepended_hash())?)
    }

    /// Check whether a message was signed by a specific address
    pub fn verify(&self, signer: Address) -> Result<(), HyperlaneProtocolError> {
        Ok(self
            .signature
            .verify(self.checkpoint.prepended_hash(), signer)?)
    }
}

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
#[derive(Clone, Debug)]
pub struct MultisigSignedCheckpoint {
    /// The checkpoint
    pub checkpoint: Checkpoint,
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
        let checkpoint = signed_checkpoints[0].signed_checkpoint.checkpoint;
        if !signed_checkpoints
            .iter()
            .all(|c| checkpoint == c.signed_checkpoint.checkpoint)
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
