//! Prover process: generate proofs in the tree.
//!
//! Struct responsible for syncing Prover

use hyperlane_core::accumulator::{
    merkle::{merkle_root_from_branch, MerkleTreeError, Proof},
    TREE_DEPTH,
};
use hyperlane_core::H256;
use tracing::instrument;

mod packed;

use packed::PackedMerkle;

/// A depth-32 sparse Merkle tree capable of producing proofs for arbitrary
/// elements.
#[derive(Debug, Default)]
pub struct Prover {
    tree: PackedMerkle,
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

impl Prover {
    /// Push a leaf to the tree. Appends it to the first unoccupied slot
    ///
    /// This will fail if the underlying tree is full.
    pub fn ingest(&mut self, element: H256) -> Result<H256, ProverError> {
        self.tree.push(element)?;
        Ok(self.tree.root())
    }

    /// Return the current root hash of the tree
    pub fn root(&self) -> H256 {
        self.tree.root()
    }

    /// Return the number of leaves that have been ingested
    pub fn count(&self) -> usize {
        self.tree.count()
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
        if leaf_index > root_index {
            return Err(ProverError::ZeroProof {
                index: leaf_index,
                count: root_index.saturating_add(1),
            });
        }
        Ok(self.tree.prove(leaf_index, root_index))
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
        slice.iter().copied().collect()
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
    #[test]
    fn rejects_unavailable_or_inverted_proofs() {
        let mut prover = Prover::default();
        assert!(prover.prove_against_previous(0, 0).is_err());
        prover.ingest(H256::from_low_u64_be(1)).unwrap();
        assert!(prover.prove_against_previous(1, 0).is_err());
        assert!(prover.prove_against_previous(0, 1).is_err());
        if let Some(index) = (u32::MAX as usize).checked_add(1) {
            assert!(prover.prove_against_previous(0, index).is_err());
        }
    }

    #[test]
    fn rebuilding_after_canonical_leaf_replacement_matches_reference() {
        use hyperlane_core::accumulator::merkle::MerkleTree;
        let mut leaves: Vec<_> = (0..513).map(H256::from_low_u64_be).collect();
        let old = Prover::from(&leaves);
        leaves[255] = H256::repeat_byte(0xff);
        let rebuilt = Prover::from(&leaves);
        let reference = MerkleTree::create(&leaves, TREE_DEPTH);
        assert_ne!(old.root(), rebuilt.root());
        assert_eq!(rebuilt.root(), reference.hash());
        for root_index in [254, 255, 256, 511, 512] {
            for leaf_index in [0, root_index] {
                assert_eq!(
                    rebuilt
                        .prove_against_previous(leaf_index, root_index)
                        .unwrap(),
                    reference.prove_against_previous(leaf_index, root_index)
                );
            }
        }
    }
    /// Run each backend in a separate process to compare peak RSS:
    /// PROVER_BENCH_BACKEND=recursive|packed PROVER_BENCH_LEAVES=1048576
    /// cargo test --release -p relayer benchmark_prover_storage -- --ignored --nocapture
    #[test]
    #[ignore = "manual memory and latency benchmark"]
    fn benchmark_prover_storage() {
        use hyperlane_core::accumulator::merkle::MerkleTree;
        use std::{hint::black_box, time::Instant};

        let count: usize = std::env::var("PROVER_BENCH_LEAVES")
            .unwrap_or_else(|_| "1048576".into())
            .parse()
            .unwrap();
        assert!(count > 1);
        let backend = std::env::var("PROVER_BENCH_BACKEND").unwrap_or_else(|_| "packed".into());
        let queries: Vec<_> = (0..10_000_usize)
            .map(|i| {
                let root = (i.wrapping_mul(2_654_435_761) % count).max(1);
                (i.wrapping_mul(2_246_822_519) % (root + 1), root)
            })
            .collect();
        let started = Instant::now();
        if backend == "recursive" {
            let mut tree = MerkleTree::create(&[], TREE_DEPTH);
            for i in 0..count {
                tree.push_leaf(H256::from_low_u64_be(i as u64 + 1), TREE_DEPTH)
                    .unwrap();
            }
            let built = started.elapsed();
            let proof_start = Instant::now();
            for (leaf, root) in queries {
                black_box(tree.prove_against_previous(leaf, root));
            }
            println!(
                "backend={backend} leaves={count} build={built:?} proofs_10000={:?}",
                proof_start.elapsed()
            );
            black_box(tree);
        } else {
            assert_eq!(backend, "packed");
            let mut prover = Prover::default();
            for i in 0..count {
                prover.ingest(H256::from_low_u64_be(i as u64 + 1)).unwrap();
            }
            let built = started.elapsed();
            let proof_start = Instant::now();
            for (leaf, root) in queries {
                black_box(prover.prove_against_previous(leaf, root).unwrap());
            }
            println!(
                "backend={backend} leaves={count} build={built:?} proofs_10000={:?}",
                proof_start.elapsed()
            );
            black_box(prover);
        }
    }
}
