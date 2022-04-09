use std::convert::TryFrom;

use crate::{AbacusError, AbacusMessage, Decode, Encode};
use color_eyre::Result;
use ethers::{core::types::H256, utils::keccak256};

/// A Stamped message that has been committed at some leaf index
#[derive(Debug, Default, Clone, PartialEq)]
pub struct RawCommittedMessage {
    /// The index at which the message is committed
    pub leaf_index: u32,
    /// The Outbox's current root when the message was committed.
    pub committed_root: H256,
    /// The fully detailed message that was committed
    pub message: Vec<u8>,
}

impl RawCommittedMessage {
    /// Return the `leaf` for this raw message
    ///
    /// The leaf is the keccak256 digest of the message, which is committed
    /// in the message tree
    pub fn leaf(&self) -> H256 {
        keccak256(&self.message).into()
    }
}

impl Encode for RawCommittedMessage {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: std::io::Write,
    {
        writer.write_all(&self.leaf_index.to_be_bytes())?;
        writer.write_all(self.committed_root.as_ref())?;
        writer.write_all(&self.message)?;
        Ok(4 + 32 + self.message.len())
    }
}

impl Decode for RawCommittedMessage {
    fn read_from<R>(reader: &mut R) -> Result<Self, AbacusError>
    where
        R: std::io::Read,
        Self: Sized,
    {
        let mut idx = [0u8; 4];
        reader.read_exact(&mut idx)?;

        let mut hash = [0u8; 32];
        reader.read_exact(&mut hash)?;

        let mut message = vec![];
        reader.read_to_end(&mut message)?;

        Ok(Self {
            leaf_index: u32::from_be_bytes(idx),
            committed_root: hash.into(),
            message,
        })
    }
}

// ember: tracingify these across usage points
/// A Stamped message that has been committed at some leaf index
#[derive(Debug, Default, Clone)]
pub struct CommittedMessage {
    /// The index at which the message is committed
    pub leaf_index: u32,
    /// The Outbox's current root when the message was committed.
    pub committed_root: H256,
    /// The fully detailed message that was committed
    pub message: AbacusMessage,
}

impl CommittedMessage {
    /// Return the leaf associated with the message
    pub fn to_leaf(&self) -> H256 {
        self.message.to_leaf()
    }
}

impl AsRef<AbacusMessage> for CommittedMessage {
    fn as_ref(&self) -> &AbacusMessage {
        &self.message
    }
}

impl TryFrom<RawCommittedMessage> for CommittedMessage {
    type Error = AbacusError;

    fn try_from(raw: RawCommittedMessage) -> Result<Self, Self::Error> {
        Ok(Self {
            leaf_index: raw.leaf_index,
            committed_root: raw.committed_root,
            message: AbacusMessage::read_from(&mut &raw.message[..])?,
        })
    }
}
