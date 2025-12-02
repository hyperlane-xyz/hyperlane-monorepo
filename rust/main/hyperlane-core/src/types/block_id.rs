use crate::H256;

/// Struct `BlockId` contains two types of identifiers for the same block: hash and height.
#[derive(Debug, Default, Copy, Clone)]
pub struct BlockId {
    /// Block hash
    pub hash: H256,
    /// Block height
    pub height: u64,
}

impl BlockId {
    /// Creates instance of `BlockId` struct
    pub fn new(hash: H256, height: u64) -> Self {
        Self { hash, height }
    }
}
