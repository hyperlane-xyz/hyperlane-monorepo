use crate::{
    accumulator::{hash_concat, merkle::Proof, ZERO_HASHES},
    H256,
};

use super::{merkle::MerkleTree, TREE_DEPTH};

/// Represents a sparse merkle tree containing O(h) nodes.
#[derive(Debug, PartialEq, Clone)]
pub struct SparseMerkleTree(MerkleTree);

impl From<&Box<MerkleTree>> for SparseMerkleTree {
    fn from(value: &Box<MerkleTree>) -> Self {
        SparseMerkleTree((**value).clone())
    }
}

impl From<SparseMerkleTree> for MerkleTree {
    fn from(value: SparseMerkleTree) -> Self {
        value.0
    }
}

impl SparseMerkleTree {
    /// Retrieve the root hash of this SparseMerkle tree.
    pub fn hash(&self) -> H256 {
        match *self {
            SparseMerkleTree(MerkleTree::Leaf(h)) => h,
            SparseMerkleTree(MerkleTree::Node(h, _, _)) => h,
            SparseMerkleTree(MerkleTree::Zero(depth)) => ZERO_HASHES[depth],
        }
    }
    /// Merges the compatible nodes from another merkle tree via DFS.
    ///
    /// This should only be run on sparse partial trees, as otherwise
    /// it can consume quite a lot of memory.
    pub fn merge(self, b: SparseMerkleTree) -> SparseMerkleTree {
        match self {
            SparseMerkleTree(MerkleTree::Zero(_)) => self,
            SparseMerkleTree(MerkleTree::Leaf(_)) => {
                if self.hash().eq(&b.hash()) {
                    b
                } else {
                    self
                }
            }
            SparseMerkleTree(MerkleTree::Node(a_hash, ref a_left, ref a_right)) => match b {
                SparseMerkleTree(MerkleTree::Leaf(_)) => self,
                SparseMerkleTree(MerkleTree::Zero(_)) => self,
                SparseMerkleTree(MerkleTree::Node(_, ref b_left, ref b_right)) => {
                    let aleft: SparseMerkleTree = a_left.into();
                    let merged_left = aleft.merge(b_left.into());
                    let aright: SparseMerkleTree = a_right.into();
                    let merged_right = aright.merge(b_right.into());
                    SparseMerkleTree(MerkleTree::Node(
                        a_hash,
                        Box::new(merged_left.into()),
                        Box::new(merged_right.into()),
                    ))
                }
            },
        }
    }
}

impl Proof {
    /// Return the proof of this index when it was the latest node in the tree
    pub fn as_latest(&self) -> Proof {
        // Replace the right nodes with zero hashes
        let mut modified_path = [H256::zero(); TREE_DEPTH];
        for i in 0..TREE_DEPTH {
            let size = self.index >> i;
            if (size & 1) == 1 {
                modified_path[i] = self.path[i];
            } else {
                modified_path[i] = ZERO_HASHES[i];
            }
        }

        Proof {
            leaf: self.leaf,
            index: self.index,
            path: modified_path,
        }
    }

    /// Creates a sparse merkle tree out of the proof
    pub fn sparse_tree(&self) -> SparseMerkleTree {
        let mut tree = MerkleTree::Leaf(self.leaf);

        for i in 0..TREE_DEPTH {
            let index = self.index >> i;
            if (index & 1) == 1 {
                let left = MerkleTree::Leaf(self.path[i]);
                let hash = hash_concat(left.hash(), tree.hash());
                tree = MerkleTree::Node(hash, Box::new(left), Box::new(tree));
            } else {
                let right = MerkleTree::Leaf(self.path[i]);
                let hash = hash_concat(tree.hash(), right.hash());
                tree = MerkleTree::Node(hash, Box::new(tree), Box::new(right));
            }
        }
        SparseMerkleTree(tree)
    }
}

#[cfg(test)]
mod tests {
    use crate::accumulator::{
        merkle::{verify_merkle_proof, MerkleTree},
        TREE_DEPTH,
    };

    use super::*;
    fn generate_proof(tree: &MerkleTree, index: usize) -> Proof {
        // Generate a proof of index i from the full merkle tree
        let (leaf, hashes) = tree.generate_proof(index, TREE_DEPTH);
        let mut path = [H256::zero(); TREE_DEPTH];
        path.copy_from_slice(&hashes[..TREE_DEPTH]);
        Proof { index, path, leaf }
    }

    #[test]
    fn as_latest() {
        const LEAF_COUNT: usize = 47;
        let all_leaves: Vec<H256> = (0..LEAF_COUNT)
            .into_iter()
            .map(|_| H256::from([0xAA; 32]))
            .collect();
        let mut roots = [H256::zero(); LEAF_COUNT];
        let mut tree = MerkleTree::create(&[], TREE_DEPTH);
        for i in 0..LEAF_COUNT {
            tree.push_leaf(all_leaves[i], TREE_DEPTH).unwrap();
            roots[i] = tree.hash();
        }

        for i in 0..LEAF_COUNT {
            // First, generate a proof of index i against the full tree
            let current_proof_i = generate_proof(&tree, i);

            // Generate a partial merkle tree from the proof of index i against the full tree
            let current_partial_tree_i = current_proof_i.sparse_tree();
            assert_eq!(current_partial_tree_i.hash(), tree.hash());

            for j in i..LEAF_COUNT {
                // Generate a proof of index j >= i from the full merkle tree
                let current_proof_j = generate_proof(&tree, j);

                // From that, generate a proof of index j from when it was the latest node in the tree
                // Verify that it matches the root that we collected as we populated the tree
                let latest_proof_j = current_proof_j.as_latest();
                assert!(verify_merkle_proof(
                    latest_proof_j.leaf,
                    &latest_proof_j.path,
                    TREE_DEPTH,
                    j,
                    roots[j]
                ));

                // From that, generate the partial merkle tree from when index j was the latest node in the tree
                let latest_partial_tree_j = latest_proof_j.sparse_tree();
                assert_eq!(latest_partial_tree_j.hash(), roots[j]);

                // Merge the partial trees together
                let merged_tree = latest_partial_tree_j.merge(current_partial_tree_i.clone());
                assert_eq!(merged_tree.hash(), roots[j]);

                // From the merged tree, pull a historical proof of index i when j was the latest node in the tree
                let historical_proof_i = generate_proof(&merged_tree.into(), i);
                assert_eq!(historical_proof_i.sparse_tree().hash(), roots[j]);
                assert!(verify_merkle_proof(
                    historical_proof_i.leaf,
                    &historical_proof_i.path,
                    TREE_DEPTH,
                    i,
                    roots[j]
                ));
            }
        }
    }
}
