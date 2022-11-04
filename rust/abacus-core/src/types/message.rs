use ethers::types::H256;
use sha3::{Digest, Keccak256};

use crate::{AbacusError, Decode, Encode};

const ABACUS_MESSAGE_PREFIX_LEN: usize = 105;

/// A Stamped message that has been committed at some leaf index
pub type RawAbacusMessage = Vec<u8>;

impl From<&AbacusMessage> for RawAbacusMessage {
    fn from(m: &AbacusMessage) -> Self {
        let mut message_vec = vec![];
        m.write_to(&mut message_vec)
        .expect("!write_to");
        message_vec
    }
}

impl Encode for RawAbacusMessage {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: std::io::Write,
    {
        writer.write_all(&self)?;
        Ok(4 + self.len())
    }
}

impl Decode for RawAbacusMessage {
    fn read_from<R>(reader: &mut R) -> Result<Self, AbacusError>
    where
        R: std::io::Read,
        Self: Sized,
    {
        let mut message = vec![];
        reader.read_to_end(&mut message)?;

        Ok(message)
    }
}
/*
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct RawAbacusMessage {
    /// The fully detailed message that was committed
    pub message: Vec<u8>,
}

impl RawAbacusMessage {
    /// Return the `id` for this raw message
    ///
    /// The id is the keccak256 digest of the message, which is committed
    /// in the message tree.
    pub fn id(&self) -> H256 {
        let buffer = [0u8; 28];
        H256::from_slice(
            Keccak256::new()
                .chain(&self.message)
                .finalize()
                .as_slice(),
        )
    }
}

impl Encode for RawAbacusMessage {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: std::io::Write,
    {
        writer.write_all(&self.message)?;
        Ok(4 + self.message.len())
    }
}

impl Decode for RawAbacusMessage {
    fn read_from<R>(reader: &mut R) -> Result<Self, AbacusError>
    where
        R: std::io::Read,
        Self: Sized,
    {
        let mut message = vec![];
        reader.read_to_end(&mut message)?;

        Ok(Self {
            message,
        })
    }
}
*/

/// A full Abacus message between chains
#[derive(Debug, Default, Clone)]
pub struct AbacusMessage {
    /// 1   Abacus version number
    pub version: u8,
    /// 4   Message nonce
    pub nonce: u32,
    /// 4   SLIP-44 ID
    pub origin: u32,
    /// 32  Address in origin convention
    pub sender: H256,
    /// 4   SLIP-44 ID
    pub destination: u32,
    /// 32  Address in destination convention
    pub recipient: H256,
    /// 0+  Message contents
    pub body: Vec<u8>,
}

impl From<Vec<u8>> for AbacusMessage {
    fn from(m: Vec<u8>) -> Self {
        let version = m[0];
        let nonce: [u8; 4] = m[1..5].try_into().unwrap();
        let origin: [u8; 4] = m[5..9].try_into().unwrap();
        let sender: [u8; 32] = m[9..41].try_into().unwrap();
        let destination: [u8; 4] = m[41..45].try_into().unwrap();
        let recipient: [u8; 32] = m[45..77].try_into().unwrap();
        let body=  m[77..].try_into().unwrap();
        Self {
            version,
            nonce: u32::from_be_bytes(nonce),
            origin: u32::from_be_bytes(origin),
            sender: H256::from(sender),
            destination: u32::from_be_bytes(destination),
            recipient: H256::from(recipient),
            body,
        }
    }
}

impl Encode for AbacusMessage {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: std::io::Write,
    {
        writer.write_all(&self.version.to_be_bytes())?;
        writer.write_all(&self.nonce.to_be_bytes())?;
        writer.write_all(&self.origin.to_be_bytes())?;
        writer.write_all(self.sender.as_ref())?;
        writer.write_all(&self.destination.to_be_bytes())?;
        writer.write_all(self.recipient.as_ref())?;
        writer.write_all(&self.body)?;
        Ok(ABACUS_MESSAGE_PREFIX_LEN + self.body.len())
    }
}

/* 
impl Decode for AbacusMessage {
    fn read_from<R>(reader: &mut R) -> Result<Self, AbacusError>
    where
        R: std::io::Read,
    {
        let mut version = [0u8; 1];
        reader.read_exact(&mut version)?;

        let mut nonce = [0u8; 4];
        reader.read_exact(&mut nonce)?;

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
            version: u8::from_be_bytes(version),
            nonce: u32::from_be_bytes(nonce),
            origin: u32::from_be_bytes(origin),
            sender,
            destination: u32::from_be_bytes(destination),
            recipient,
            body,
        })
    }
}
*/

impl AbacusMessage {
    /// Convert the message to a leaf
    pub fn id(&self) -> H256 {
        let buffer = [0u8; 28];
        H256::from_slice(
            Keccak256::new()
                .chain(&self.to_vec())
                .chain(buffer)
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
