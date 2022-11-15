use ethers::types::H256;
use sha3::{Digest, Keccak256};

use crate::{HyperlaneError, Decode, Encode};

const ABACUS_MESSAGE_PREFIX_LEN: usize = 77;

/// A Stamped message that has been committed at some leaf index
pub type RawHyperlaneMessage = Vec<u8>;

impl From<&HyperlaneMessage> for RawHyperlaneMessage {
    fn from(m: &HyperlaneMessage) -> Self {
        let mut message_vec = vec![];
        m.write_to(&mut message_vec).expect("!write_to");
        message_vec
    }
}

impl Encode for RawHyperlaneMessage {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: std::io::Write,
    {
        writer.write_all(self)?;
        Ok(4 + self.len())
    }
}

impl Decode for RawHyperlaneMessage {
    fn read_from<R>(reader: &mut R) -> Result<Self, HyperlaneError>
    where
        R: std::io::Read,
        Self: Sized,
    {
        let mut message = vec![];
        reader.read_to_end(&mut message)?;

        Ok(message)
    }
}

/// A full Hyperlane message between chains
#[derive(Debug, Default, Clone)]
pub struct HyperlaneMessage {
    /// 1   Hyperlane version number
    pub version: u8,
    /// 4   Message nonce
    pub nonce: u32,
    /// 4   Hyperlane Domain ID
    pub origin: u32,
    /// 32  Address in origin convention
    pub sender: H256,
    /// 4   Hyperlane Domain ID
    pub destination: u32,
    /// 32  Address in destination convention
    pub recipient: H256,
    /// 0+  Message contents
    pub body: Vec<u8>,
}

impl From<RawHyperlaneMessage> for HyperlaneMessage {
    fn from(m: RawHyperlaneMessage) -> Self {
        HyperlaneMessage::from(&m)
    }
}

impl From<&RawHyperlaneMessage> for HyperlaneMessage {
    fn from(m: &RawHyperlaneMessage) -> Self {
        let version = m[0];
        let nonce: [u8; 4] = m[1..5].try_into().unwrap();
        let origin: [u8; 4] = m[5..9].try_into().unwrap();
        let sender: [u8; 32] = m[9..41].try_into().unwrap();
        let destination: [u8; 4] = m[41..45].try_into().unwrap();
        let recipient: [u8; 32] = m[45..77].try_into().unwrap();
        let body = m[77..].try_into().unwrap();
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

impl Encode for HyperlaneMessage {
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

impl HyperlaneMessage {
    /// Convert the message to a message id
    pub fn id(&self) -> H256 {
        H256::from_slice(Keccak256::new().chain(&self.to_vec()).finalize().as_slice())
    }
}

impl std::fmt::Display for HyperlaneMessage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "HyperlaneMessage {}->{}", self.origin, self.destination)
    }
}
