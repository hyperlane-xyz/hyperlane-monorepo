use derive_new::new;
use std::io::{Read, Write};

use crate::{Decode, Encode, HyperlaneProtocolError, H256};

/// Merkle Tree Hook insertion event
#[derive(Debug, Copy, Clone, new)]
pub struct MerkleTreeInsertion {
    leaf_index: u32,
    message_id: H256,
}

impl MerkleTreeInsertion {
    /// The leaf index of this insertion
    pub fn index(&self) -> u32 {
        self.leaf_index
    }

    /// ID of the message inserted
    pub fn message_id(&self) -> H256 {
        self.message_id
    }
}

impl Encode for MerkleTreeInsertion {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: Write,
    {
        Ok(self.leaf_index.write_to(writer)? + self.message_id.write_to(writer)?)
    }
}

impl Decode for MerkleTreeInsertion {
    fn read_from<R>(reader: &mut R) -> Result<Self, HyperlaneProtocolError>
    where
        R: Read,
        Self: Sized,
    {
        Ok(Self {
            leaf_index: u32::read_from(reader)?,
            message_id: H256::read_from(reader)?,
        })
    }
}
