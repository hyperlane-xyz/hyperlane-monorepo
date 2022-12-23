//! Prover process: generate proofs in the tree.
//!
//! Struct responsible for syncing Prover

use hyperlane_core::accumulator::{
    merkle::{merkle_root_from_branch, MerkleTree, MerkleTreeError, Proof},
    TREE_DEPTH, ZERO_HASHES
};
use hyperlane_core::H256;

/// A depth-32 sparse Merkle tree capable of producing proofs for arbitrary
/// elements.
#[derive(Debug)]
pub struct Prover {
    count: usize,
    tree: MerkleTree,
}

/// Prover Errors
#[derive(Debug, thiserror::Error)]
pub enum ProverError {
    /// Index is above tree max size
    #[error("Requested proof for index above u32::MAX: {0}")]
    IndexTooHigh(usize),
    /// Requested proof for a zero element
    #[error("Requested proof for a zero element. Requested: {index}. Tree has: {count}")]
    ZeroProof {
        /// The index requested
        index: usize,
        /// The number of leaves
        count: usize,
    },
    /// Bubbled up from underlying
    #[error(transparent)]
    MerkleTreeError(#[from] MerkleTreeError),
    /// Failed proof verification
    #[error("Proof verification failed. Root is {expected}, produced is {actual}")]
    #[allow(dead_code)]
    VerificationFailed {
        /// The expected root (this tree's current root)
        expected: H256,
        /// The root produced by branch evaluation
        actual: H256,
    },
}

impl Default for Prover {
    fn default() -> Self {
        let full = MerkleTree::create(&[], TREE_DEPTH);
        Self {
            count: 0,
            tree: full,
        }
    }
}


// Okay, what functions do I need?
// reconstruct_leading_branch(index)
// 

// TODO(asa): Modify prover to return proofs of leaf indices against previous roots.
impl Prover {
    /// Push a leaf to the tree. Appends it to the first unoccupied slot
    ///
    /// This will fail if the underlying tree is full.
    pub fn ingest(&mut self, element: H256) -> Result<H256, ProverError> {
        self.count += 1;
        self.tree.push_leaf(element, TREE_DEPTH)?;
        Ok(self.tree.hash())
    }

    /// Return the current root hash of the tree
    pub fn root(&self) -> H256 {
        self.tree.hash()
    }

    /// Return the number of leaves that have been ingested
    pub fn count(&self) -> usize {
        self.count
    }

    /// Returns a merkle proof of `index` against a historic version of the
    /// tree where `index` was the most recent element pushed to the tree. 
    /// 
    /// We do this by creating a proof against the current root, and then
    /// modifying it by replacing all "right nodes" in the proof with the
    /// root of the empty tree at that height, as represented by ZERO_HASHES.
    fn historic_proof_of_latest_index(&self, index: usize) -> Result<Proof, ProverError> {
        // A proof against the current root.
        let current_proof = self.prove_current(index)?;

        // Replace the right nodes with zero hashes
        let mut modified_path = [H256::zero(); 32];
        for i in 0..32 {
            let size = index >> i;
            if (size & 1) == 1 {
                modified_path[i] = ZERO_HASHES[i];
            } else {
                modified_path[i] = current_proof.path[i].clone();
            }
        }

        Ok(Proof { leaf: current_proof.leaf, index, path: modified_path })
    }

    /// Returns the "leading branch" from a proof.
    /// tree where `index` was the most recent element pushed to the tree. 
    /// 
    /// We do this by creating a proof against the current root, and then
    /// modifying it by replacing all "right nodes" in the proof with the
    /// root of the empty tree at that height, as represented by ZERO_HASHES.
    fn historic_leading_branch_of_latest_index(&self, index: usize) -> Result<Proof, ProverError> {
        // A proof against the current root.
        let current_proof = self.prove_current(index)?;

        // Replace the right nodes with zero hashes
        let mut modified_path = [H256::zero(); 32];
        for i in 0..32 {
            let size = index >> i;
            if (size & 1) == 1 {
                modified_path[i] = ZERO_HASHES[i];
            } else {
                modified_path[i] = current_proof.path[i].clone();
            }
        }

        Ok(Proof { leaf: current_proof.leaf, index, path: modified_path })
    }

    
    

    /// Create a proof of a leaf against the current or a previous checkpoint.
    /// 
    /// First creates a merkle proof against the current root, then subsitutes
    /// elements of the proof that represent indices > `checkpoint_index` with the roots
    /// of empty trees.
    pub fn prove(&self, index: usize, checkpoint_index: usize) -> Result<Proof, ProverError> {
        if index >= checkpoint_index {
            return Err(ProverError::IndexTooHigh(index));
        }
        let current_proof = self.prove_current(index)?;
        let mut path = [H256::zero(); 32];
        for node in current_proof.path {

        }
        let mut size = checkpoint_index;

        /// Hmm the assumption was that "right nodes" could be set to zeroes.
        /// But actually, we need to figure out *which* right nodes can be set to zeroes.
        /// Those lower in the tree should be left alone, those higher in the tree should not
        /// How do we decide how high? Maybe something in the difference in indices?
        current_proof.path.iter().enumerate().for_each(|(i, elem)| {
            if (size & 1) == 1 {
                hash_concat(elem, node)
            } else {
                hash_concat(node, ZERO_HASHES[i])
            };
            size /= 2;
        });




        path.copy_from_slice(&hashes[..32]);
        Ok(Proof { leaf, index, path })
    }

    /// Verify a proof against this tree's root.
    #[allow(dead_code)]
    pub fn verify(&self, proof: &Proof) -> Result<(), ProverError> {
        let actual = merkle_root_from_branch(proof.leaf, &proof.path, TREE_DEPTH, proof.index);
        let expected = self.root();
        if expected == actual {
            Ok(())
        } else {
            Err(ProverError::VerificationFailed { expected, actual })
        }
    }

    fn prove_current(&self, index: usize) -> Result<Proof, ProverError> {
        if index > u32::MAX as usize {
            return Err(ProverError::IndexTooHigh(index));
        }
        let count = self.count();
        if index >= count {
            return Err(ProverError::ZeroProof { index, count });
        }

        let (leaf, hashes) = self.tree.generate_proof(index, TREE_DEPTH);
        let mut path = [H256::zero(); 32];
        path.copy_from_slice(&hashes[..32]);
        Ok(Proof { leaf, index, path })
    }
}

impl<T> From<T> for Prover
where
    T: AsRef<[H256]>,
{
    fn from(t: T) -> Self {
        let slice = t.as_ref();
        Self {
            count: slice.len(),
            tree: MerkleTree::create(slice, TREE_DEPTH),
        }
    }
}

impl std::iter::FromIterator<H256> for Prover {
    /// Will panic if the tree fills
    fn from_iter<I: IntoIterator<Item = H256>>(iter: I) -> Self {
        let mut prover = Self::default();
        prover.extend(iter);
        prover
    }
}

impl std::iter::Extend<H256> for Prover {
    /// Will panic if the tree fills
    fn extend<I: IntoIterator<Item = H256>>(&mut self, iter: I) {
        for i in iter {
            self.ingest(i).expect("!tree full");
        }
    }
}

#[cfg(test)]
mod test {
    use ethers::utils::hash_message;

    use hyperlane_core::test_utils;

    use super::*;

    #[test]
    fn it_produces_and_verifies_proofs() {
        let test_cases = test_utils::load_merkle_test_json();

        for test_case in test_cases.iter() {
            let mut tree = Prover::default();

            // insert the leaves
            for leaf in test_case.leaves.iter() {
                let hashed_leaf = hash_message(leaf);
                tree.ingest(hashed_leaf).unwrap();
            }

            // assert the tree has the proper leaf count
            assert_eq!(tree.count(), test_case.leaves.len());

            // assert the tree generates the proper root
            let root = tree.root(); // root is type H256
            assert_eq!(root, test_case.expected_root);

            for n in 0..test_case.leaves.len() {
                // assert the tree generates the proper proof for this leaf
                let proof = tree.prove(n).unwrap();
                assert_eq!(proof, test_case.proofs[n]);

                // check that the tree can verify the proof for this leaf
                tree.verify(&proof).unwrap();
            }
        }
    }
}
