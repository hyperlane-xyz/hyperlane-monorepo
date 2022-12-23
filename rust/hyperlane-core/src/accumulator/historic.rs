use crate::{
    H256,
    accumulator::{ZERO_HASHES,
    merkle::{Proof},
    },
};

impl Proof {
    /// Return the proof of this index when it was the latest node in the tree
    pub fn as_latest(&self) -> Proof {
        // Replace the right nodes with zero hashes
        let mut modified_path = [H256::zero(); 32];
        for i in 0..32 {
            let size = self.index >> i;
            if (size & 1) == 1 {
                modified_path[i] = self.path[i].clone();
            } else {
                modified_path[i] = ZERO_HASHES[i];
            }
        }

        Proof { leaf: self.leaf, index: self.index, path: modified_path }
    }
}

#[cfg(test)]
mod tests {
    use crate::accumulator::{merkle::{MerkleTree, verify_merkle_proof}, TREE_DEPTH};

    use super::*;

    #[test]
    fn as_latest() {
        const LEAF_COUNT: usize = 47;
        let all_leaves: Vec<H256> = (0..LEAF_COUNT).into_iter().map(|_| {
            H256::from([0xAA; 32])
        }).collect();
        let mut roots = [H256::zero(); LEAF_COUNT];
        let mut tree = MerkleTree::create(&[], TREE_DEPTH);
        for i in 0..LEAF_COUNT {
            tree.push_leaf(all_leaves[i], TREE_DEPTH).unwrap();
            roots[i] = tree.hash();
        }

        for i in 0..LEAF_COUNT {
            let (actual_leaf, actual_hashes) = tree.generate_proof(i, TREE_DEPTH);
            let mut path = [H256::zero(); TREE_DEPTH];
            path.copy_from_slice(&actual_hashes[..TREE_DEPTH]);

            let proof = Proof{index: i, path, leaf: actual_leaf}.as_latest();
            assert!(verify_merkle_proof(proof.leaf, &proof.path, TREE_DEPTH, i, roots[i]));

        }
    }
}
