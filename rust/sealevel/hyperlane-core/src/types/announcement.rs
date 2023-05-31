use sha3::digest::Update;
use sha3::{Digest, Keccak256};

use crate::{Signable, H160, H256};

/// An Hyperlane checkpoint
#[derive(Clone, Eq, PartialEq)]
pub struct Announcement {
    /// The validator address
    pub validator: H160,
    /// The mailbox address
    pub mailbox_address: H256,
    /// The mailbox chain
    pub mailbox_domain: u32,
    /// The location of signed checkpoints
    pub storage_location: String,
}

impl Signable for Announcement {
    fn signing_hash(&self) -> H256 {
        H256::from_slice(
            Keccak256::new()
                .chain(announcement_domain_hash(
                    self.mailbox_address,
                    self.mailbox_domain,
                ))
                .chain(&self.storage_location)
                .finalize()
                .as_slice(),
        )
    }
}

/// Computes hash of domain concatenated with "HYPERLANE_ANNOUNCEMENT"
pub fn announcement_domain_hash(address: H256, domain: impl Into<u32>) -> H256 {
    H256::from_slice(
        Keccak256::new()
            .chain(domain.into().to_be_bytes())
            .chain(address)
            .chain("HYPERLANE_ANNOUNCEMENT")
            .finalize()
            .as_slice(),
    )
}
