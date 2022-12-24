use crate::{
    accumulator::{hash_concat, merkle::Proof, ZERO_HASHES},
    H256,
};

use super::{merkle::MerkleTree, TREE_DEPTH};

impl MerkleTree {
    /// Merges the compatible nodes from another merkle tree via DFS.
    ///
    /// This should only be run on sparse partial trees, as otherwise
    /// it can consume quite a lot of memory.
    pub fn merge(self, b: MerkleTree) -> MerkleTree {
        match self {
            MerkleTree::Zero(_) => self,
            MerkleTree::Leaf(_) => {
                if self.hash().eq(&b.hash()) {
                    b
                } else {
                    self
                }
            }
            MerkleTree::Node(a_hash, ref a_left, ref a_right) => match b {
                MerkleTree::Leaf(_) => self,
                MerkleTree::Zero(_) => self,
                MerkleTree::Node(_, b_left, b_right) => {
                    let merged_left = (**a_left).clone().merge((*b_left).clone());
                    let merged_right = (**a_right).clone().merge((*b_right).clone());
                    let merged_hash = hash_concat(merged_left.hash(), merged_right.hash());
                    assert_eq!(merged_hash, a_hash);
                    MerkleTree::Node(
                        a_hash,
                        Box::new(merged_left),
                        Box::new(merged_right),
                    )
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

    /// Creates a partial merkle tree out of the proof
    pub fn partial_tree(&self) -> MerkleTree {
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
        tree
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
            let current_partial_tree_i = current_proof_i.partial_tree();
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
                let latest_partial_tree_j = latest_proof_j.partial_tree();
                assert_eq!(latest_partial_tree_j.hash(), roots[j]);

                // Merge the partial trees together
                let merged_tree = latest_partial_tree_j
                    .clone()
                    .merge(current_partial_tree_i.clone());
                assert_eq!(merged_tree.hash(), roots[j]);

                // From the merged tree, pull a historical proof of index i when j was the latest node in the tree
                let historical_proof_i = generate_proof(&merged_tree, i);
                assert_eq!(historical_proof_i.partial_tree().hash(), roots[j]);
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
