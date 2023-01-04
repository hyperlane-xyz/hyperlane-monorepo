use ethers::{
    prelude::{Address, Signature},
    utils::hash_message,
};
use ethers_signers::Signer;
use serde::{Deserialize, Serialize};
use sha3::{Digest, Keccak256};

use crate::{utils::domain_hash, HyperlaneProtocolError, SignerExt, H256};

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

impl Announcement {
    /// A hash of the checkpoint contents.
    /// The EIP-191 compliant version of this hash is signed by validators.
    pub fn signing_hash(&self) -> H256 {
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

    /// EIP-191 compliant hash of the signing hash of the checkpoint.
    pub fn eth_signed_message_hash(&self) -> H256 {
        hash_message(self.signing_hash())
    }

    /// Sign an checkpoint using the specified signer
    pub async fn sign_with<S: Signer>(self, signer: &S) -> Result<SignedAnnouncement, S::Error> {
        let signature = signer
            .sign_message_without_eip_155(self.signing_hash())
            .await?;
        Ok(SignedAnnouncement {
            announcement: self,
            signature,
        })
    }
}

/// A Signed Hyperlane checkpoint
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SignedAnnouncement {
    /// The announcement
    pub announcement: Announcement,
    /// The signature
    pub signature: Signature,
}

impl SignedAnnouncement {
    /// Recover the Ethereum address of the signer
    pub fn recover(&self) -> Result<Address, HyperlaneProtocolError> {
        Ok(self
            .signature
            .recover(self.announcement.eth_signed_message_hash())?)
    }

    /// Check whether a message was signed by a specific address
    pub fn verify(&self, signer: Address) -> Result<(), HyperlaneProtocolError> {
        Ok(self
            .signature
            .verify(self.announcement.eth_signed_message_hash(), signer)?)
    }
}
