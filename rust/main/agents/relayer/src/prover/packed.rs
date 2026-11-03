//! Completed Merkle subtrees stored in fixed-size chunks.
//!
//! Level h contains the roots of the complete 2^h-leaf subtrees. These roots
//! never change as leaves are appended; an incomplete right edge is reconstructed
//! from lower levels and zero hashes when calculating a root or historical proof.

use hyperlane_core::{
    accumulator::{merkle::MerkleTreeError, merkle::Proof, TREE_DEPTH, ZERO_HASHES},
    H256,
};
use sha3::{Digest, Keccak256};

// Limit unused capacity to one 8 KiB chunk per populated level. Growing a Vec
// of hashes geometrically would nearly double its memory just past powers of two.
const HASHES_PER_CHUNK: usize = 256;

#[derive(Debug, Default)]
struct Level {
    chunks: Vec<Box<[H256; HASHES_PER_CHUNK]>>,
    len: usize,
}

impl Level {
    fn push(&mut self, hash: H256) {
        let offset = self.len % HASHES_PER_CHUNK;
        if offset == 0 {
            self.chunks.push(Box::new([H256::zero(); HASHES_PER_CHUNK]));
        }
        self.chunks[self.len / HASHES_PER_CHUNK][offset] = hash;
        self.len = self.len.saturating_add(1);
    }

    fn get(&self, index: usize) -> H256 {
        assert!(index < self.len, "Merkle subtree index is not populated");
        self.chunks[index / HASHES_PER_CHUNK][index % HASHES_PER_CHUNK]
    }
}

#[derive(Debug)]
pub(super) struct PackedMerkle {
    levels: [Level; TREE_DEPTH + 1],
    count: usize,
    root: H256,
}

impl Default for PackedMerkle {
    fn default() -> Self {
        Self {
            levels: std::array::from_fn(|_| Level::default()),
            count: 0,
            root: ZERO_HASHES[TREE_DEPTH],
        }
    }
}

impl PackedMerkle {
    pub(super) fn count(&self) -> usize {
        self.count
    }

    pub(super) fn root(&self) -> H256 {
        self.root
    }

    pub(super) fn push(&mut self, leaf: H256) -> Result<(), MerkleTreeError> {
        if self.count as u64 >= 1_u64 << TREE_DEPTH {
            return Err(MerkleTreeError::MerkleTreeFull);
        }
        let mut node = leaf;
        let next_count = self
            .count
            .checked_add(1)
            .ok_or(MerkleTreeError::MerkleTreeFull)?;
        let mut size = next_count;
        for level in &mut self.levels {
            level.push(node);
            if size & 1 == 1 {
                break;
            }
            node = hash_pair(
                level.get(
                    level
                        .len
                        .checked_sub(2)
                        .expect("Completed subtree has a left sibling"),
                ),
                node,
            );
            size >>= 1;
        }
        self.count = next_count;
        self.root = self.subtree_root(0, TREE_DEPTH, self.count as u64);
        Ok(())
    }

    // Only one branch can contain the incomplete right edge. The recursion
    // therefore visits O(TREE_DEPTH) nodes, including for historical roots.
    fn subtree_root(&self, start: u64, height: usize, count: u64) -> H256 {
        if start >= count {
            return ZERO_HASHES[height];
        }
        if start.saturating_add(1_u64 << height) <= count {
            // This index is below count, which came from a representable usize.
            return self.levels[height].get((start >> height) as usize);
        }
        let child_height = height.checked_sub(1).expect("Partial subtree has children");
        let half = 1_u64 << child_height;
        hash_pair(
            self.subtree_root(start, child_height, count),
            self.subtree_root(start.saturating_add(half), child_height, count),
        )
    }

    // The caller checks leaf_index <= root_index < count.
    pub(super) fn prove(&self, leaf_index: usize, root_index: usize) -> Proof {
        let mut path = [H256::zero(); TREE_DEPTH];
        for (height, sibling) in path.iter_mut().enumerate() {
            let sibling_start = (((leaf_index as u64) >> height) ^ 1) << height;
            *sibling =
                self.subtree_root(sibling_start, height, (root_index as u64).saturating_add(1));
        }
        Proof {
            leaf: self.levels[0].get(leaf_index),
            index: leaf_index,
            path,
        }
    }
}

fn hash_pair(left: H256, right: H256) -> H256 {
    H256::from_slice(
        &Keccak256::new()
            .chain_update(left)
            .chain_update(right)
            .finalize(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyperlane_core::accumulator::{incremental::IncrementalMerkle, merkle::MerkleTree};
    use rand::{rngs::StdRng, Rng, SeedableRng};

    #[test]
    fn historical_proofs_match_recursive_tree() {
        let mut rng = StdRng::seed_from_u64(0x7061636b6564);
        for duplicate_leaves in [false, true] {
            let mut packed = PackedMerkle::default();
            let mut reference = MerkleTree::create(&[], TREE_DEPTH);
            let mut incremental = IncrementalMerkle::default();
            let mut roots = Vec::new();
            let mut leaves = Vec::new();
            assert_eq!(packed.root(), reference.hash());
            for index in 0..=HASHES_PER_CHUNK {
                let leaf = if duplicate_leaves {
                    H256::zero()
                } else {
                    H256(rng.gen())
                };
                packed.push(leaf).unwrap();
                reference.push_leaf(leaf, TREE_DEPTH).unwrap();
                incremental.ingest(leaf);
                assert_eq!(packed.count(), index + 1);
                assert_eq!(packed.root(), reference.hash());
                assert_eq!(packed.root(), incremental.root());
                roots.push(packed.root());
                leaves.push(leaf);
            }
            // Compare the final packed tree against an independent tree containing
            // exactly each historical prefix, exhausting every valid pair.
            let mut historical_reference = MerkleTree::create(&[], TREE_DEPTH);
            for (root_index, root) in roots.iter().enumerate() {
                historical_reference
                    .push_leaf(leaves[root_index], TREE_DEPTH)
                    .unwrap();
                assert_eq!(historical_reference.hash(), *root);
                for leaf_index in 0..=root_index {
                    let proof = packed.prove(leaf_index, root_index);
                    assert_eq!(
                        proof,
                        historical_reference.prove_against_current(leaf_index)
                    );
                    if leaf_index == 0 || leaf_index == root_index {
                        assert_eq!(proof.root(), *root);
                    }
                }
            }
        }
    }

    #[test]
    fn chunk_and_power_of_two_boundaries_match() {
        let mut rng = StdRng::seed_from_u64(0x626f756e64617279);
        let mut packed = PackedMerkle::default();
        let mut reference = MerkleTree::create(&[], TREE_DEPTH);
        let mut roots = Vec::new();
        for index in 0_usize..4097 {
            let leaf = H256(rng.gen());
            packed.push(leaf).unwrap();
            reference.push_leaf(leaf, TREE_DEPTH).unwrap();
            roots.push(reference.hash());
            assert_eq!(packed.root(), reference.hash());
            let count = index + 1;
            if count.is_power_of_two() || count % HASHES_PER_CHUNK <= 1 {
                for _ in 0..32 {
                    let root_index = rng.gen_range(0..count);
                    let leaf_index = rng.gen_range(0..=root_index);
                    let proof = packed.prove(leaf_index, root_index);
                    assert_eq!(
                        proof,
                        reference.prove_against_previous(leaf_index, root_index)
                    );
                    assert_eq!(proof.root(), roots[root_index]);
                }
            }
        }
        let allocated_hashes: usize = packed
            .levels
            .iter()
            .map(|level| level.chunks.len() * HASHES_PER_CHUNK)
            .sum();
        assert!(allocated_hashes < 2 * packed.count() + (TREE_DEPTH + 1) * HASHES_PER_CHUNK);
    }
    #[test]
    fn full_tree_rejects_before_mutation() {
        let mut packed = PackedMerkle::default();
        // Exercise the capacity guard without allocating 2^32 leaves.
        let capacity = usize::try_from(1_u64 << TREE_DEPTH).unwrap_or(usize::MAX);
        packed.count = capacity;
        let root = packed.root();
        assert_eq!(
            packed.push(H256::zero()),
            Err(MerkleTreeError::MerkleTreeFull)
        );
        assert_eq!(packed.count(), capacity);
        assert_eq!(packed.root(), root);
        assert!(packed.levels.iter().all(|level| level.len == 0));
        // A completely populated depth-32 root is read directly from level 32.
        packed.levels[TREE_DEPTH].push(H256::repeat_byte(0x42));
        assert_eq!(
            packed.subtree_root(0, TREE_DEPTH, 1_u64 << TREE_DEPTH),
            H256::repeat_byte(0x42)
        );
    }

    #[test]
    #[should_panic(expected = "Merkle subtree index is not populated")]
    fn unused_chunk_capacity_cannot_be_read() {
        let mut level = Level::default();
        level.push(H256::zero());
        level.get(1);
    }
}
