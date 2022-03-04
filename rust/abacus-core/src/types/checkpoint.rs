use crate::{utils::home_domain_hash, AbacusError, Decode, Encode, SignerExt};
use ethers::{
    prelude::{Address, Signature},
    types::H256,
    utils::hash_message,
};
use ethers_signers::Signer;
use serde::{Deserialize, Serialize};
use sha3::{Digest, Keccak256};

/// An Abacus checkpoint
#[derive(Copy, Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Checkpoint {
    /// The outbox chain
    pub outbox_domain: u32,
    /// The checkpointed root
    pub root: H256,
    /// The index of the checkpoint
    /// TODO: change to larger than 32 bits
    pub index: u32,
}

impl std::fmt::Display for Checkpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Update(domain {} moved from {} to {})",
            self.outbox_domain, self.root, self.index
        )
    }
}

impl Encode for Checkpoint {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: std::io::Write,
    {
        writer.write_all(&self.outbox_domain.to_be_bytes())?;
        writer.write_all(self.root.as_ref())?;
        writer.write_all(&self.index.to_be_bytes())?;
        Ok(4 + 32 + 4)
    }
}

impl Decode for Checkpoint {
    fn read_from<R>(reader: &mut R) -> Result<Self, AbacusError>
    where
        R: std::io::Read,
        Self: Sized,
    {
        let mut outbox_domain = [0u8; 4];
        reader.read_exact(&mut outbox_domain)?;

        let mut root = H256::zero();
        reader.read_exact(root.as_mut())?;

        let mut index = [0u8; 4];
        reader.read_exact(&mut index)?;

        Ok(Self {
            outbox_domain: u32::from_be_bytes(outbox_domain),
            root,
            index: u32::from_be_bytes(index),
        })
    }
}

impl Checkpoint {
    fn signing_hash(&self) -> H256 {
        // sign:
        // domain(home_domain) || previous_root || new_root
        H256::from_slice(
            Keccak256::new()
                .chain(home_domain_hash(self.outbox_domain))
                .chain(self.root)
                .chain(self.index.to_be_bytes())
                .finalize()
                .as_slice(),
        )
    }

    fn prepended_hash(&self) -> H256 {
        hash_message(self.signing_hash())
    }

    /// Sign an update using the specified signer
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

/// Metadata stored about an update
#[derive(Copy, Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct CheckpointMeta {
    /// Block number
    pub block_number: u64,
}

impl Encode for CheckpointMeta {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: std::io::Write,
    {
        let mut written = 0;
        written += self.block_number.write_to(writer)?;
        Ok(written)
    }
}

impl Decode for CheckpointMeta {
    fn read_from<R>(reader: &mut R) -> Result<Self, AbacusError>
    where
        R: std::io::Read,
        Self: Sized,
    {
        let mut block_number = [0u8; 8];
        reader.read_exact(&mut block_number)?;

        Ok(Self {
            block_number: u64::from_be_bytes(block_number),
        })
    }
}

/// A Checkpoint with Meta
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct CheckpointWithMeta {
    /// The update
    pub checkpoint: Checkpoint,
    /// The metadata
    pub metadata: CheckpointMeta,
}

/// A Signed Abacus Update
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SignedCheckpoint {
    /// The update
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
    fn read_from<R>(reader: &mut R) -> Result<Self, AbacusError>
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
    pub fn recover(&self) -> Result<Address, AbacusError> {
        Ok(self.signature.recover(self.checkpoint.prepended_hash())?)
    }

    /// Check whether a message was signed by a specific address
    pub fn verify(&self, signer: Address) -> Result<(), AbacusError> {
        Ok(self
            .signature
            .verify(self.checkpoint.prepended_hash(), signer)?)
    }
}
