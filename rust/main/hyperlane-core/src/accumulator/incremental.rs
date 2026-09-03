use borsh::{BorshDeserialize, BorshSerialize};
use derive_new::new;

use crate::accumulator::{
    hash_concat,
    merkle::{merkle_root_from_branch, Proof},
    H256, TREE_DEPTH, ZERO_HASHES,
};

#[derive(BorshSerialize, Debug, Clone, new, PartialEq, Eq)]
/// An incremental merkle tree, modeled on the eth2 deposit contract
pub struct IncrementalMerkle {
    /// The branch of the tree
    pub branch: [H256; TREE_DEPTH],
    /// The number of leaves in the tree
    pub count: usize,
}

/// Custom BorshDeserialize to avoid stack overflow in Solana BPF.
/// The derived impl deserializes `[H256; 32]` in a nested stack frame (1024 bytes),
/// then copies it back into the caller's frame (another 1024 bytes). These stacked
/// frames can exceed the 4KB BPF stack limit during CPI calls.
/// This impl does everything in a single frame, and `#[inline(never)]` prevents it
/// from being merged with other large-stack callers.
impl BorshDeserialize for IncrementalMerkle {
    #[inline(never)]
    fn deserialize_reader<R: std::io::Read>(reader: &mut R) -> std::io::Result<Self> {
        let mut branch = [H256::zero(); TREE_DEPTH];
        for item in branch.iter_mut() {
            *item = H256::deserialize_reader(reader)?;
        }
        let count = usize::deserialize_reader(reader)?;
        Ok(Self { branch, count })
    }
}

impl Default for IncrementalMerkle {
    fn default() -> Self {
        let mut branch: [H256; TREE_DEPTH] = Default::default();
        branch
            .iter_mut()
            .enumerate()
            .for_each(|(i, elem)| *elem = ZERO_HASHES[i]);
        Self { branch, count: 0 }
    }
}

impl IncrementalMerkle {
    /// Ingest a leaf into the tree.
    pub fn ingest(&mut self, element: H256) {
        let mut node = element;
        assert!(self.count < u32::MAX as usize);
        self.count = self.count.saturating_add(1);
        let mut size = self.count;
        for i in 0..TREE_DEPTH {
            if (size & 1) == 1 {
                self.branch[i] = node;
                return;
            }
            node = hash_concat(self.branch[i], node);
            size /= 2;
        }
    }

    /// Calculate the current tree root
    pub fn root(&self) -> H256 {
        let mut node: H256 = Default::default();
        let mut size = self.count;

        self.branch.iter().enumerate().for_each(|(i, elem)| {
            node = if (size & 1) == 1 {
                hash_concat(elem, node)
            } else {
                hash_concat(node, ZERO_HASHES[i])
            };
            size /= 2;
        });

        node
    }

    /// Get the number of items in the tree
    pub fn count(&self) -> usize {
        self.count
    }

    /// Get the index
    pub fn index(&self) -> u32 {
        assert!(self.count > 0, "index is invalid when tree is empty");
        (self.count as u32).saturating_sub(1)
    }

    /// Get the leading-edge branch.
    pub fn branch(&self) -> &[H256; TREE_DEPTH] {
        &self.branch
    }

    /// Calculate the root of a branch for incremental given the index
    pub fn branch_root(item: H256, branch: [H256; TREE_DEPTH], index: usize) -> H256 {
        merkle_root_from_branch(item, &branch, 32, index)
    }

    /// Verify an incremental merkle proof of inclusion
    pub fn verify(&self, proof: &Proof) -> bool {
        let computed = IncrementalMerkle::branch_root(proof.leaf, proof.path, proof.index);
        computed == self.root()
    }
}

/// A persisted snapshot of an `IncrementalMerkle`: just the O(depth) frontier
/// plus the leaf count (about a kilobyte), not the full tree. A validator
/// restart can restore this instead of re-ingesting every historical leaf from
/// the local database, then replay only the tail and let the usual
/// root-equality check against the correctness checkpoint prove the result.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct MerkleTreeSnapshot {
    /// Index of the last leaf covered by the snapshot (`count - 1`).
    pub index: u32,
    /// Tree root at the snapshot index.
    pub root: H256,
    /// Borsh-serialized `IncrementalMerkle`.
    pub tree: Vec<u8>,
}

impl MerkleTreeSnapshot {
    /// Capture the current tree state. Fails on an empty tree, which has no
    /// meaningful index.
    pub fn capture(tree: &IncrementalMerkle) -> eyre::Result<Self> {
        if tree.count() == 0 {
            eyre::bail!("Cannot snapshot an empty merkle tree");
        }
        Ok(Self {
            index: (tree.count() as u32).saturating_sub(1),
            root: tree.root(),
            tree: borsh::to_vec(tree)?,
        })
    }

    /// Restore the tree, verifying the bytes actually decode to the claimed
    /// index and root. Callers must additionally check the root against a
    /// trusted checkpoint before replaying onto the restored tree.
    pub fn restore(&self) -> eyre::Result<IncrementalMerkle> {
        let tree: IncrementalMerkle = borsh::from_slice(&self.tree)?;
        if tree.count() == 0 || (tree.count() as u32).saturating_sub(1) != self.index {
            eyre::bail!(
                "Snapshot index {} does not match decoded tree count {}",
                self.index,
                tree.count(),
            );
        }
        if tree.root() != self.root {
            eyre::bail!("Snapshot root does not match decoded tree root");
        }
        Ok(tree)
    }
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn borsh_roundtrip() {
        let mut tree = IncrementalMerkle::default();
        tree.ingest(H256::from([1u8; 32]));
        tree.ingest(H256::from([2u8; 32]));
        let serialized = borsh::to_vec(&tree).unwrap();
        let deserialized: IncrementalMerkle = borsh::from_slice(&serialized).unwrap();
        assert_eq!(tree, deserialized);
    }

    #[test]
    fn borsh_roundtrip_empty() {
        let tree = IncrementalMerkle::default();
        let serialized = borsh::to_vec(&tree).unwrap();
        let deserialized: IncrementalMerkle = borsh::from_slice(&serialized).unwrap();
        assert_eq!(tree, deserialized);
    }

    #[test]
    fn borsh_roundtrip_deep() {
        let mut tree = IncrementalMerkle::default();
        for i in 0u64..100 {
            let mut leaf = [0u8; 32];
            leaf[..8].copy_from_slice(&i.to_le_bytes());
            tree.ingest(H256::from(leaf));
        }
        let serialized = borsh::to_vec(&tree).unwrap();
        let deserialized: IncrementalMerkle = borsh::from_slice(&serialized).unwrap();
        assert_eq!(tree, deserialized);
    }

    #[test]
    fn snapshot_capture_restore_round_trip() {
        let mut tree = IncrementalMerkle::default();
        assert!(MerkleTreeSnapshot::capture(&tree).is_err());
        for i in 0..17u64 {
            tree.ingest(H256::from_low_u64_be(i));
        }
        let snapshot = MerkleTreeSnapshot::capture(&tree).unwrap();
        assert_eq!(snapshot.index, 16);
        assert_eq!(snapshot.root, tree.root());
        // ~1 KiB frontier, not the full tree.
        assert!(snapshot.tree.len() < 2048);
        let restored = snapshot.restore().unwrap();
        assert_eq!(restored, tree);

        let mut tampered = snapshot.clone();
        tampered.root = H256::from_low_u64_be(0xdead);
        assert!(tampered.restore().is_err());
        let mut misindexed = snapshot.clone();
        misindexed.index += 1;
        assert!(misindexed.restore().is_err());
    }
}

#[cfg(all(test, feature = "ethers"))]
mod ethers_test {
    use ethers_core::utils::hash_message;

    use crate::test_utils;

    use super::*;

    #[test]
    fn it_computes_branch_roots() {
        let test_cases = test_utils::load_merkle_test_json();

        for test_case in test_cases.iter() {
            let mut tree = IncrementalMerkle::default();

            // insert the leaves
            for leaf in test_case.leaves.iter() {
                let hashed_leaf = hash_message(leaf);
                tree.ingest(hashed_leaf.into());
            }

            // assert the tree has the proper leaf count
            assert_eq!(tree.count(), test_case.leaves.len());

            // assert the tree generates the proper root
            let root = tree.root(); // root is type H256
            assert_eq!(root, test_case.expected_root);

            for n in 0..test_case.leaves.len() {
                // check that the tree can verify the proof for this leaf
                assert!(tree.verify(&test_case.proofs[n]));
            }
        }
    }
}
