use ethers::prelude::{H160, H256};

use crate::{Decode, Encode};

/// Identifier type.
///
/// Normally these will map to address types for different networks. For Abacus,
/// we choose to _always_ serialize as 32 bytes
#[derive(Debug, Default, Copy, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AbacusIdentifier(H256);

impl AbacusIdentifier {
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

impl From<H256> for AbacusIdentifier {
    fn from(address: H256) -> Self {
        AbacusIdentifier(address)
    }
}

impl From<H160> for AbacusIdentifier {
    fn from(address: H160) -> Self {
        let mut id = AbacusIdentifier::default();
        id.as_mut()[12..].copy_from_slice(address.as_ref());
        id
    }
}

impl AsRef<[u8]> for AbacusIdentifier {
    fn as_ref(&self) -> &[u8] {
        self.0.as_ref()
    }
}

impl AsMut<[u8]> for AbacusIdentifier {
    fn as_mut(&mut self) -> &mut [u8] {
        self.0.as_mut()
    }
}

impl From<AbacusIdentifier> for H256 {
    fn from(addr: AbacusIdentifier) -> Self {
        addr.0
    }
}

impl From<AbacusIdentifier> for [u8; 32] {
    fn from(addr: AbacusIdentifier) -> Self {
        addr.0.into()
    }
}

impl Encode for AbacusIdentifier {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: std::io::Write,
    {
        self.0.write_to(writer)
    }
}

impl Decode for AbacusIdentifier {
    fn read_from<R>(reader: &mut R) -> Result<Self, crate::AbacusError>
    where
        R: std::io::Read,
        Self: Sized,
    {
        Ok(AbacusIdentifier(H256::read_from(reader)?))
    }
}
