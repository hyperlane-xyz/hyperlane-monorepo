use crate::{
    accumulator::{hash_concat, merkle::Proof, ZERO_HASHES},
    H256,
};

use super::{merkle::MerkleTree, TREE_DEPTH};

impl Proof {
    /// Return the proof of this index when it was the latest node in the tree
    fn as_latest(&self) -> Proof {
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
}

/// Represents a sparse merkle tree containing O(h) nodes.
#[derive(Debug, PartialEq, Clone)]
struct SparseMerkleTree(MerkleTree);

impl From<SparseMerkleTree> for MerkleTree {
    fn from(value: SparseMerkleTree) -> Self {
        value.0
    }
}

impl SparseMerkleTree {
    /// Retrieve the root hash of this SparseMerkle tree.
    fn hash(&self) -> H256 {
        match *self {
            SparseMerkleTree(MerkleTree::Leaf(h)) => h,
            SparseMerkleTree(MerkleTree::Node(h, _, _)) => h,
            SparseMerkleTree(MerkleTree::Zero(depth)) => ZERO_HASHES[depth],
        }
    }

    /// Merges the sparse merkle tree `b` into `self` via DFS.
    ///
    /// A node in `self` is merged with a node in `b` iff the hashes of both
    /// nodes are equal.
    fn merge(self, b: SparseMerkleTree) -> SparseMerkleTree {
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
                    let merged_hash = hash_concat(merged_left.hash(), merged_right.hash());
                    assert_eq!(merged_hash, a_hash);
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

impl From<&Box<MerkleTree>> for SparseMerkleTree {
    fn from(value: &Box<MerkleTree>) -> Self {
        SparseMerkleTree((**value).clone())
    }
}

impl From<Proof> for SparseMerkleTree {
    fn from(value: Proof) -> Self {
        let mut tree = MerkleTree::Leaf(value.leaf);

        for i in 0..TREE_DEPTH {
            let index = value.index >> i;
            if (index & 1) == 1 {
                let left = MerkleTree::Leaf(value.path[i]);
                let hash = hash_concat(left.hash(), tree.hash());
                tree = MerkleTree::Node(hash, Box::new(left), Box::new(tree));
            } else {
                let right = MerkleTree::Leaf(value.path[i]);
                let hash = hash_concat(tree.hash(), right.hash());
                tree = MerkleTree::Node(hash, Box::new(tree), Box::new(right));
            }
        }
        SparseMerkleTree(tree)
    }
}

impl MerkleTree {
    /// Create a proof of a leaf in this tree against the latest merkle root.
    ///
    /// Note, if the tree ingests more leaves, the root will need to be recalculated.
    pub fn prove_against_current(&self, index: usize) -> Proof {
        let (leaf, hashes) = self.generate_proof(index, TREE_DEPTH);
        let mut path = [H256::zero(); 32];
        path.copy_from_slice(&hashes[..32]);
        Proof { leaf, index, path }
    }

    /// Create a proof of a leaf in this tree against a previous merkle root.
    pub fn prove_against_previous(&self, leaf_index: usize, root_index: usize) -> Proof {
        assert!(root_index >= leaf_index);
        let root_proof = self.prove_against_current(root_index).as_latest();
        let leaf_proof = self.prove_against_current(leaf_index);
        let tree = SparseMerkleTree::from(root_proof).merge(leaf_proof.into());
        MerkleTree::from(tree).prove_against_current(leaf_index)
    }
}

#[cfg(test)]
mod tests {
    use crate::accumulator::{
        merkle::{verify_merkle_proof, MerkleTree},
        TREE_DEPTH,
    };

    use super::*;

    fn tree_and_roots() -> (MerkleTree, Vec<H256>) {
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
        (tree, roots.to_vec())
    }

    #[test]
    fn as_latest() {
        let (tree, roots) = tree_and_roots();

        for i in 0..roots.len() {
            let current_proof_i = tree.prove_against_current(i);
            let latest_proof_i = current_proof_i.as_latest();
            assert!(verify_merkle_proof(
                latest_proof_i.leaf,
                &latest_proof_i.path,
                TREE_DEPTH,
                i,
                roots[i]
            ));
        }
    }

    #[test]
    fn prove_against_previous() {
        let (tree, roots) = tree_and_roots();
        for i in 0..roots.len() {
            for j in i..roots.len() {
                let proof = tree.prove_against_previous(i, j);
                assert_eq!(proof.root(), roots[j]);
                assert!(verify_merkle_proof(
                    proof.leaf,
                    &proof.path,
                    TREE_DEPTH,
                    i,
                    roots[j]
                ));
            }
        }
    }
}
