use crate::types::H256;
use borsh::{BorshDeserialize, BorshSerialize};

use crate::accumulator::{
    hash_concat,
    merkle::{merkle_root_from_branch, Proof},
    TREE_DEPTH, ZERO_HASHES,
};

#[derive(BorshDeserialize, BorshSerialize, Debug, Clone, Copy)]
/// An incremental merkle tree, modeled on the eth2 deposit contract
pub struct IncrementalMerkle {
    branch: [H256; TREE_DEPTH],
    count: usize,
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
        self.count += 1;
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

    /// Get the leading-edge branch.
    pub fn branch(&self) -> &[H256; TREE_DEPTH] {
        &self.branch
    }

    /// Calculate the root of a branch for incremental given the index
    pub fn branch_root(item: H256, branch: [H256; TREE_DEPTH], index: usize) -> H256 {
        merkle_root_from_branch(item, &branch, 32, index)
    }

    /// Verify a incremental merkle proof of inclusion
    pub fn verify(&self, proof: &Proof) -> bool {
        let computed = IncrementalMerkle::branch_root(proof.leaf, proof.path, proof.index as usize);
        computed == self.root()
    }
}

#[cfg(all(test))]
mod test {
    use super::*;

    use std::{fs::File, io::Read, path::PathBuf};

    use sha3::{digest::Update, Digest, Keccak256};

    // From ethers-rs
    fn hash_message<S>(message: S) -> H256
    where
        S: AsRef<[u8]>,
    {
        const PREFIX: &str = "\x19Ethereum Signed Message:\n";
        let message = message.as_ref();

        let mut eth_message = format!("{}{}", PREFIX, message.len()).into_bytes();
        eth_message.extend_from_slice(message);

        H256::from_slice(Keccak256::new().chain(eth_message).finalize().as_slice())
    }

    // From test_utils.rs
    fn find_vector(final_component: &str) -> PathBuf {
        let cwd = std::env::current_dir().expect("no cwd?");
        let git_dir = cwd
            .ancestors() // . ; ../ ; ../../ ; ...
            .find(|d| d.join(".git").is_dir())
            .expect("could not find .git somewhere! confused about workspace layout");

        git_dir.join("vectors").join(final_component)
    }

    #[derive(serde::Deserialize, serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct MerkleTestCase {
        /// Test case name
        pub test_name: String,
        /// Leaves of merkle tree
        pub leaves: Vec<String>,
        /// Proofs for leaves in tree
        pub proofs: Vec<Proof>,
        /// Root of tree
        pub expected_root: H256,
    }

    fn load_merkle_test_json() -> Vec<MerkleTestCase> {
        let mut file = File::open(find_vector("merkle.json")).unwrap();
        let mut data = String::new();
        file.read_to_string(&mut data).unwrap();
        serde_json::from_str(&data).unwrap()
    }

    #[test]
    fn it_computes_branch_roots() {
        let test_cases = load_merkle_test_json();

        for test_case in test_cases.iter() {
            let mut tree = IncrementalMerkle::default();

            // insert the leaves
            for leaf in test_case.leaves.iter() {
                let hashed_leaf = hash_message(leaf);
                tree.ingest(hashed_leaf);
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
