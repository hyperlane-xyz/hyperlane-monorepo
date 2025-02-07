use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use sha3::{digest::Update, Digest, Keccak256};
use std::fmt::{Debug, Formatter};

use crate::utils::{fmt_address_for_domain, fmt_domain};
use crate::{utils::announcement_domain_hash, Signable, SignedType, H160, H256};

/// An Hyperlane checkpoint
#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
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

impl Debug for Announcement {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Announcement {{ validator: {:?}, mailbox_address: {}, mailbox_domain: {}, storage_location: {} }}",
            self.validator,
            fmt_address_for_domain(self.mailbox_domain, self.mailbox_address),
            fmt_domain(self.mailbox_domain),
            self.storage_location
        )
    }
}

#[async_trait]
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

/// An announcement that has been signed.
pub type SignedAnnouncement = SignedType<Announcement>;
