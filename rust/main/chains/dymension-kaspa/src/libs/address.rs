use derive_new::new;
use hyperlane_core::{ChainCommunicationError, ChainResult, H256};
use std::str::FromStr;

#[derive(new, Debug, Clone)]
pub struct KaspaAddress {
    /// Hex representation (digest) of cosmos account
    digest: H256,
}

impl KaspaAddress {
    /// Creates a wrapper around a cosmrs AccountId from a private key byte array
    pub fn from_privkey(priv_key: &[u8], prefix: &str) -> ChainResult<Self> {
        Err(ChainCommunicationError::from_other_str("not implemented"))
    }

    /// Creates a wrapper around a cosmrs AccountId from a H256 digest
    ///
    /// - digest: H256 digest (hex representation of address)
    /// - prefix: Bech32 prefix
    /// - byte_count: Number of bytes to truncate the digest to. Cosmos addresses can sometimes
    ///     be less than 32 bytes, so this helps to serialize it in bech32 with the appropriate
    ///     length.
    pub fn from_h256(digest: H256, prefix: &str, byte_count: usize) -> ChainResult<Self> {
        Err(ChainCommunicationError::from_other_str("not implemented"))
    }

    /// String representation of a cosmos AccountId
    pub fn address(&self) -> String {
        "".to_string()
    }

    /// H256 digest of the cosmos AccountId
    pub fn digest(&self) -> H256 {
        self.digest
    }
}

impl TryFrom<&KaspaAddress> for H256 {
    type Error = ChainCommunicationError;

    fn try_from(addr: &KaspaAddress) -> Result<Self, Self::Error> {
        Err(ChainCommunicationError::from_other_str("not implemented"))
    }
}

impl FromStr for KaspaAddress {
    type Err = ChainCommunicationError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Err(ChainCommunicationError::from_other_str("not implemented"))
    }
}
