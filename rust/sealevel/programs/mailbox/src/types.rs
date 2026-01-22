//! Type definitions for the Mailbox program.

use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::{accumulator::incremental::IncrementalMerkle, H256};
use shank::ShankType;

/// An incremental merkle tree, modeled on the eth2 deposit contract.
/// This structurally replicates hyperlane_core::accumulator::incremental::IncrementalMerkle
/// with Shank annotations for IDL generation.
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, PartialEq, Eq, ShankType)]
pub struct MerkleTree {
    /// The branch of the tree (32 H256 hashes, each 32 bytes)
    #[idl_type("Vec<[u8; 32]>")]
    pub branch: [H256; 32],
    /// The number of leaves in the tree
    pub count: usize,
}

impl Default for MerkleTree {
    fn default() -> Self {
        let inner = IncrementalMerkle::default();
        Self::from(inner)
    }
}

impl MerkleTree {
    /// Ingest a leaf into the tree.
    pub fn ingest(&mut self, element: H256) {
        let mut inner = IncrementalMerkle::from(self.clone());
        inner.ingest(element);
        *self = Self::from(inner);
    }

    /// Calculate the current tree root
    pub fn root(&self) -> H256 {
        let inner = IncrementalMerkle::from(self.clone());
        inner.root()
    }
}

impl From<IncrementalMerkle> for MerkleTree {
    fn from(merkle: IncrementalMerkle) -> Self {
        Self {
            branch: merkle.branch,
            count: merkle.count,
        }
    }
}

impl From<MerkleTree> for IncrementalMerkle {
    fn from(tree: MerkleTree) -> Self {
        Self {
            branch: tree.branch,
            count: tree.count,
        }
    }
}

impl From<&MerkleTree> for IncrementalMerkle {
    fn from(tree: &MerkleTree) -> Self {
        Self {
            branch: tree.branch,
            count: tree.count,
        }
    }
}
