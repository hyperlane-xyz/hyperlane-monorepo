use sha3::digest::Update;
use sha3::{Digest, Keccak256};

use crate::{
    H256,
    Signable,
};

pub struct Checkpoint {
    /// The mailbox address
    pub mailbox_address: H256,
    /// The mailbox chain
    pub mailbox_domain: u32,
    /// The checkpointed root
    pub root: H256,
    /// The index of the checkpoint
    pub index: u32,
    /// The ID of the message at the index.
    pub message_id: H256,
}

impl Signable for Checkpoint {
    fn signing_hash(&self) -> H256 {
        let mut bytes = [0u8; 76];
        bytes[0..32].copy_from_slice(&self.mailbox_address[..]);
        bytes[4..8].copy_from_slice(&self.mailbox_domain.to_be_bytes());
        bytes[8..40].copy_from_slice(&self.root[..]);
        bytes[40..44].copy_from_slice(&self.index.to_be_bytes());
        bytes[44..76].copy_from_slice(&self.message_id[..]);

        H256::from_slice(Keccak256::new().chain(&bytes).finalize().as_slice())
    }
}
