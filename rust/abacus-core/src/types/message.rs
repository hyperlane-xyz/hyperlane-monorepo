use ethers::types::H256;
use sha3::{Digest, Keccak256};

use crate::{AbacusError, Decode, Encode};

const ABACUS_MESSAGE_PREFIX_LEN: usize = 72;

/// A Stamped message that has been committed at some leaf index
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct RawCommittedMessage {
    /// The index at which the message is committed
    pub leaf_index: u32,
    /// The fully detailed message that was committed
    pub message: Vec<u8>,
}

impl RawCommittedMessage {
    /// Return the `leaf` for this raw message
    ///
    /// The leaf is the keccak256 digest of the message, which is committed
    /// in the message tree
    pub fn leaf(&self) -> H256 {
        let buffer = [0u8; 28];
        H256::from_slice(
            Keccak256::new()
                .chain(&self.message)
                .chain(buffer)
                .chain(self.leaf_index.to_be_bytes())
                .finalize()
                .as_slice(),
        )
    }
}

impl Encode for RawCommittedMessage {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: std::io::Write,
    {
        writer.write_all(&self.leaf_index.to_be_bytes())?;
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

        let mut message = vec![];
        reader.read_to_end(&mut message)?;

        Ok(Self {
            leaf_index: u32::from_be_bytes(idx),
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
    /// The fully detailed message that was committed
    pub message: AbacusMessage,
}

impl CommittedMessage {
    /// Return the leaf associated with the message
    pub fn to_leaf(&self) -> H256 {
        self.message.to_leaf(self.leaf_index)
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
        (&raw).try_into()
    }
}

impl TryFrom<&RawCommittedMessage> for CommittedMessage {
    type Error = AbacusError;

    fn try_from(raw: &RawCommittedMessage) -> Result<Self, Self::Error> {
        Ok(Self {
            leaf_index: raw.leaf_index,
            message: AbacusMessage::read_from(&mut raw.message.as_slice())?,
        })
    }
}

/// A full Abacus message between chains
#[derive(Debug, Default, Clone)]
pub struct AbacusMessage {
    /// 4   SLIP-44 ID
    pub origin: u32,
    /// 32  Address in Outbox convention
    pub sender: H256,
    /// 4   SLIP-44 ID
    pub destination: u32,
    /// 32  Address in destination convention
    pub recipient: H256,
    /// 0+  Message contents
    pub body: Vec<u8>,
}

/// A partial Abacus message between chains
#[derive(Debug, Default, Clone)]
pub struct Message {
    /// 4   SLIP-44 ID
    pub destination: u32,
    /// 32  Address in destination convention
    pub recipient: H256,
    /// 0+  Message contents
    pub body: Vec<u8>,
}

impl Encode for AbacusMessage {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: std::io::Write,
    {
        writer.write_all(&self.origin.to_be_bytes())?;
        writer.write_all(self.sender.as_ref())?;
        writer.write_all(&self.destination.to_be_bytes())?;
        writer.write_all(self.recipient.as_ref())?;
        writer.write_all(&self.body)?;
        Ok(ABACUS_MESSAGE_PREFIX_LEN + self.body.len())
    }
}

impl Decode for AbacusMessage {
    fn read_from<R>(reader: &mut R) -> Result<Self, AbacusError>
    where
        R: std::io::Read,
    {
        let mut origin = [0u8; 4];
        reader.read_exact(&mut origin)?;

        let mut sender = H256::zero();
        reader.read_exact(sender.as_mut())?;

        let mut destination = [0u8; 4];
        reader.read_exact(&mut destination)?;

        let mut recipient = H256::zero();
        reader.read_exact(recipient.as_mut())?;

        let mut body = vec![];
        reader.read_to_end(&mut body)?;

        Ok(Self {
            origin: u32::from_be_bytes(origin),
            sender,
            destination: u32::from_be_bytes(destination),
            recipient,
            body,
        })
    }
}

impl AbacusMessage {
    /// Convert the message to a leaf
    pub fn to_leaf(&self, leaf_index: u32) -> H256 {
        let buffer = [0u8; 28];
        H256::from_slice(
            Keccak256::new()
                .chain(&self.to_vec())
                .chain(buffer)
                .chain(leaf_index.to_be_bytes())
                .finalize()
                .as_slice(),
        )
    }
}

impl std::fmt::Display for AbacusMessage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "AbacusMessage {}->{}", self.origin, self.destination)
    }
}
