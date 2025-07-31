//! Prover process: generate proofs in the tree.
//!
//! Struct responsible for syncing Prover

use hyperlane_core::accumulator::{
    merkle::{merkle_root_from_branch, MerkleTree, MerkleTreeError, Proof},
    TREE_DEPTH,
};
use hyperlane_core::H256;
use tracing::{error, instrument};

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
        expected: Box<H256>,
        /// The root produced by branch evaluation
        actual: Box<H256>,
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

    /// Create a proof of a leaf in this tree.
    #[instrument(err, skip(self), fields(prover_msg_count=self.count()))]
    pub fn prove_against_previous(
        &self,
        leaf_index: usize,
        root_index: usize,
    ) -> Result<Proof, ProverError> {
        if root_index > u32::MAX as usize {
            return Err(ProverError::IndexTooHigh(root_index));
        }
        let count = self.count();
        if root_index >= count {
            return Err(ProverError::ZeroProof {
                index: root_index,
                count,
            });
        }
        Ok(self.tree.prove_against_previous(leaf_index, root_index))
    }

    /// Verify a proof against this tree's root.
    #[allow(dead_code)]
    pub fn verify(&self, proof: &Proof) -> Result<(), ProverError> {
        let actual = merkle_root_from_branch(proof.leaf, &proof.path, TREE_DEPTH, proof.index);
        let expected = self.root();
        if expected == actual {
            Ok(())
        } else {
            Err(ProverError::VerificationFailed {
                expected: Box::new(expected),
                actual: Box::new(actual),
            })
        }
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
                tree.ingest(hashed_leaf.into()).unwrap();
            }

            // assert the tree has the proper leaf count
            assert_eq!(tree.count(), test_case.leaves.len());

            // assert the tree generates the proper root
            let root = tree.root(); // root is type H256
            assert_eq!(root, test_case.expected_root);

            for n in 0..test_case.leaves.len() {
                // assert the tree generates the proper proof for this leaf
                let proof = tree.prove_against_previous(n, tree.count() - 1).unwrap();
                assert_eq!(proof, test_case.proofs[n]);

                // check that the tree can verify the proof for this leaf
                tree.verify(&proof).unwrap();
            }
        }
    }
}
