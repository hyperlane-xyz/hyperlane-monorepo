use tracing::info;

use crate::{
    H256,
    accumulator::{ZERO_HASHES, hash_concat,
    merkle::{Proof},
    },
};

use super::{TREE_DEPTH, merkle::MerkleTree};

impl MerkleTree {
    /// Merges the compatible nodes from another merkle tree via BFS.
    /// 
    /// This should only be run on sparse partial trees, as otherwise
    /// it can consume quite a lot of memory.
    pub fn merge(self, b: MerkleTree) -> MerkleTree {
        println!("Merging trees...");
        // Mismatched nodes cannot be merged 
        if !self.hash().eq(&b.hash()) {
            return self
        }

        match self {
            MerkleTree::Zero(_) => {
                println!("I am a zero node, returning self");
                return self
            },
            MerkleTree::Leaf(_) => {
                println!("I am a leaf node, returning other");
                return b
            }
            MerkleTree::Node(a_hash, ref a_left, ref a_right) => {
                match b {
                    MerkleTree::Leaf(_) => {
                        println!("I am an internal node and other is a leaf, returning self");
                        return self
                    },
                    MerkleTree::Zero(_) => {
                        println!("I am an internal node and other is a zero, returning self");
                        return self
                    },
                    MerkleTree::Node(_, b_left, b_right) => {
                        println!("I am an internal node and other is an internal node, merging");
                        // TODO: this can't be right...
                        let merged_left = (**a_left).clone().merge((*b_left).clone());
                        let merged_right = (**a_right).clone().merge((*b_right).clone());
                        let merged_hash = hash_concat(merged_left.hash(), merged_right.hash());
                        assert_eq!(merged_hash, a_hash);
                        return MerkleTree::Node(a_hash.clone(), Box::new(merged_left), Box::new(merged_right));
                    }
                }
            }
        }
    }
}

impl Proof {
    /// Return the proof of this index when it was the latest node in the tree
    pub fn proof_as_latest(&self) -> Proof {
        // Replace the right nodes with zero hashes
        let mut modified_path = [H256::zero(); TREE_DEPTH];
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

    /// Creates a partial merkle tree out of the proof
    pub fn partial_tree(&self) -> MerkleTree {
        let mut tree = MerkleTree::Leaf(self.leaf);

        for i in 0..32 {
            let index = self.index >> i;
            if (index & 1) == 1 {
                let left = MerkleTree::Leaf(self.path[i]);
                let hash = hash_concat(left.hash(), tree.hash());
                println!("Added left node {:x}", hash);
                tree = MerkleTree::Node(hash, Box::new(left), Box::new(tree));
            } else {

                let right = MerkleTree::Leaf(self.path[i]);
                let hash = hash_concat(tree.hash(), right.hash());
                println!("Added right node {:x}", hash);
                tree = MerkleTree::Node(hash, Box::new(tree), Box::new(right));
            }
        }
        tree
    }

    // Okay, so what we have here is actually a reconstruction of the partial merkle tree.
    // What would I do with this?
    // Well, I could have two partial merkle trees, one for 
    /// Returns the internal nodes of 
    pub fn internal_nodes(&self) -> (usize, [H256; TREE_DEPTH]) {
        let latest_proof = self.proof_as_latest();

        let mut branch = [H256::zero(); TREE_DEPTH];

        let mut current = self.leaf;

        for i in 0..TREE_DEPTH {
            branch[i] = current;
            let next = latest_proof.path[i];
            let ith_bit = (self.index >> i) & 0x01;
            if ith_bit == 1 {
                current = hash_concat(current, next);
            } else {
                current = hash_concat(next, current);
            }
        }
        (self.index, branch)
    }

    // TODO: Naming..
    /// Returns the proof of this index when the latest node in the tree
    /// was latest.index.
    /// 
    /// `latest` is expected to be a proof against the current version of the tree.
    pub fn as_historic(&self, latest: Proof) -> Proof {
        todo!();
        /*

        // Represents the leading edge branch of the merkle tree with the latest
        // node at index latest_proof.index
        let leading_branch = 

        // For each element in proof, 
        let mut modified_path = [H256::zero(); 32];
        for i in 0..32 {
            // Okay, the nodes we have from the latest proof will be of index latest_proof.index >> i;
            // The nodes we need for the modified proof will be of index self.index >> i

            let size = self.index >> i;
            let need = self.index >> i 
            if (size & 1) == 1 {
                modified_path[i] = self.path[i].clone();
            } else {
                modified_path[i] = ZERO_HASHES[i];
            }
        }

        Proof { leaf: self.leaf, index: self.index, path: modified_path }
        */
    }
}

#[cfg(test)]
mod tests {
    use std::thread::current;

    use crate::accumulator::{merkle::{MerkleTree, verify_merkle_proof}, incremental::{IncrementalMerkle}, TREE_DEPTH};

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

        let mut current_merged_tree = MerkleTree::Leaf(tree.hash());

        for i in 0..LEAF_COUNT {
            let (actual_leaf, actual_hashes) = tree.generate_proof(i, TREE_DEPTH);
            let mut path = [H256::zero(); TREE_DEPTH];
            path.copy_from_slice(&actual_hashes[..TREE_DEPTH]);

            let current_proof = Proof{index: i, path, leaf: actual_leaf};
            let proof = current_proof.proof_as_latest();
            assert!(verify_merkle_proof(proof.leaf, &proof.path, TREE_DEPTH, i, roots[i]));

            let current_partial_tree = current_proof.partial_tree();
            assert_eq!(current_partial_tree.hash(), tree.hash());

            current_merged_tree = current_merged_tree.merge(current_partial_tree);
            assert_eq!(current_merged_tree.hash(), tree.hash());

            let partial_tree = proof.partial_tree();
            assert_eq!(partial_tree.hash(), roots[i]);
        }
    }

    /*
    #[test]
    fn as_leading_branch() {
        const LEAF_COUNT: usize = 47;
        let all_leaves: Vec<H256> = (0..LEAF_COUNT).into_iter().map(|_| {
            H256::from([0xAA; 32])
        }).collect();
        let mut branches = [[H256::zero(); TREE_DEPTH]; LEAF_COUNT];
        let mut incremental_tree = IncrementalMerkle::default();
        let mut full_tree = MerkleTree::create(&[], TREE_DEPTH);
        for i in 0..LEAF_COUNT {
            incremental_tree.ingest(all_leaves[i]);
            full_tree.push_leaf(all_leaves[i], TREE_DEPTH).unwrap();
            branches[i] = incremental_tree.branch().clone();
        }


        // Want to generate the proof of i when j was the latest node in the tree..
        for i in 0..LEAF_COUNT {
            // Pull the proof of i from full_tree
            let (proof_leaf, proof_path) = full_tree.generate_proof(i, TREE_DEPTH);
            let mut modified_path = [H256::zero(); TREE_DEPTH];
            modified_path.copy_from_slice(&proof_path[..TREE_DEPTH]);
            let proof = Proof{index: i, path: modified_path, leaf: proof_leaf};
            let branch = proof.proof_as_latest().latest_branch();
            assert_eq!(branch.1, branches[i]);
        }
    }

    #[test]
    fn as_historic() {
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

        // Want to generate the proof of i when j was the latest node in the tree..
        for i in 0..LEAF_COUNT {
            for j in i..LEAF_COUNT {
                // First, pull the proof of j when it was the latest element in the tree
                let (latest_leaf, latest_hashes) = tree.generate_proof(j, TREE_DEPTH);
                let mut latest_path = [H256::zero(); TREE_DEPTH];
                latest_path.copy_from_slice(&latest_hashes[..TREE_DEPTH]);
                let latest_proof = Proof{index: j, path: latest_path, leaf: latest_leaf}.as_latest();

                // Then, pull the proof of i, when j was the latest element in the tree
                let (index_leaf, index_hashes) = tree.generate_proof(i, TREE_DEPTH);
                let mut index_path = [H256::zero(); TREE_DEPTH];
                index_path.copy_from_slice(&index_hashes[..TREE_DEPTH]);
                let historic_proof = Proof{index: i, path: index_path, leaf: index_leaf}.as_historic(latest_proof);

                assert!(verify_merkle_proof(historic_proof.leaf, &historic_proof.path, TREE_DEPTH, i, roots[j]));
            }
        }
    }
    */
}
