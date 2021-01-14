use crate::accumulator::{TREE_DEPTH, ZERO_HASHES};
use ethers_core::types::H256;
use sha3::{Digest, Keccak256};

#[derive(Debug, Clone, Copy)]
pub struct IncrementalMerkle {
    branch: [H256; TREE_DEPTH],
    count: u32,
}

fn hash_concat(left: impl AsRef<[u8]>, right: impl AsRef<[u8]>) -> H256 {
    let mut k = Keccak256::new();
    k.update(left.as_ref());
    k.update(right.as_ref());
    let digest = k.finalize();
    H256::from_slice(digest.as_slice())
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
    pub fn ingest(&mut self, element: H256) {
        let mut node = element;
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
        unreachable!()
    }

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

    pub fn count(&self) -> u32 {
        self.count
    }

    pub fn branch(&self) -> &[H256; TREE_DEPTH] {
        &self.branch
    }
}
