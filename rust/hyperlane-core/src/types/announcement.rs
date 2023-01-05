use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use sha3::{Digest, Keccak256};

use crate::{
    utils::domain_hash, HyperlaneSigner, HyperlaneSignerError, Signable, SignedType, H256,
};

/// An Hyperlane checkpoint
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Announcement {
    /// The mailbox address
    pub mailbox_address: H256,
    /// The mailbox chain
    pub mailbox_domain: u32,
    /// The checkpointed root
    pub storage_metadata: String,
}

impl std::fmt::Display for Announcement {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Announcement(domain: {}, mailbox: {:x}, metadata: {})",
            self.mailbox_domain, self.mailbox_address, self.storage_metadata
        )
    }
}

#[async_trait]
impl Signable for Announcement {
    fn signing_hash(&self) -> H256 {
        // sign:
        // domain_hash(mailbox_address, mailbox_domain) || metadata
        H256::from_slice(
            Keccak256::new()
                .chain(domain_hash(self.mailbox_address, self.mailbox_domain))
                .chain(self.storage_metadata.clone())
                .finalize()
                .as_slice(),
        )
    }

    async fn sign_with(
        self,
        signer: &impl HyperlaneSigner,
    ) -> Result<SignedAnnouncement, HyperlaneSignerError> {
        let signature = signer.sign_hash(&self.signing_hash()).await?;
        Ok(SignedType {
            value: self,
            signature,
        })
    }
}

/// An announcement that has been signed.
pub type SignedAnnouncement = SignedType<Announcement>;
