use std::ops::Deref;

use uuid::Uuid;

use crate::{Decode, Encode, HyperlaneProtocolError, H160, H256};

/// Identifier type.
///
/// Normally these will map to address types for different networks. For
/// Hyperlane, we choose to _always_ serialize as 32 bytes
#[derive(Debug, Default, Copy, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct HyperlaneIdentifier(H256);

impl HyperlaneIdentifier {
    /// Check if the identifier is an ethereum address. This checks
    /// that the first 12 bytes are all 0.
    pub fn is_ethereum_address(&self) -> bool {
        self.0.as_bytes()[0..12].iter().all(|b| *b == 0)
    }

    /// Cast to an ethereum address by truncating.
    pub fn as_ethereum_address(&self) -> H160 {
        H160::from_slice(&self.0.as_ref()[12..])
    }
}

impl From<H256> for HyperlaneIdentifier {
    fn from(address: H256) -> Self {
        HyperlaneIdentifier(address)
    }
}

impl From<H160> for HyperlaneIdentifier {
    fn from(address: H160) -> Self {
        let mut id = HyperlaneIdentifier::default();
        id.as_mut()[12..].copy_from_slice(address.as_ref());
        id
    }
}

impl AsRef<[u8]> for HyperlaneIdentifier {
    fn as_ref(&self) -> &[u8] {
        self.0.as_ref()
    }
}

impl AsMut<[u8]> for HyperlaneIdentifier {
    fn as_mut(&mut self) -> &mut [u8] {
        self.0.as_mut()
    }
}

impl From<HyperlaneIdentifier> for H256 {
    fn from(addr: HyperlaneIdentifier) -> Self {
        addr.0
    }
}

impl From<HyperlaneIdentifier> for [u8; 32] {
    fn from(addr: HyperlaneIdentifier) -> Self {
        addr.0.into()
    }
}

impl Encode for HyperlaneIdentifier {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: std::io::Write,
    {
        self.0.write_to(writer)
    }
}

impl Decode for HyperlaneIdentifier {
    fn read_from<R>(reader: &mut R) -> Result<Self, HyperlaneProtocolError>
    where
        R: std::io::Read,
        Self: Sized,
    {
        Ok(HyperlaneIdentifier(H256::read_from(reader)?))
    }
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize, PartialEq, Eq, Hash, Default)]
/// Unique identifier type
pub struct UniqueIdentifier(Uuid);

impl UniqueIdentifier {
    /// Create a new unique identifier
    pub fn new(uuid: Uuid) -> Self {
        UniqueIdentifier(uuid)
    }

    /// Create a new random unique identifier
    pub fn random() -> Self {
        UniqueIdentifier(Uuid::new_v4())
    }
}

impl Deref for UniqueIdentifier {
    type Target = Uuid;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl std::fmt::Display for UniqueIdentifier {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
