use crate::{
    merkle::{verify_merkle_proof, MerkleTree, ZERO_HASHES},
    *,
};
use ethers_core::types::H256;
use sha3::Keccak256;

pub const TREE_DEPTH: usize = 32;
pub const MAX_MESSAGES: u32 = u32::MAX;

#[derive(Debug, Clone, Copy)]
pub struct Proof {
    leaf: H256,
    index: usize,
    path: [H256; TREE_DEPTH],
}

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

#[derive(Debug)]
pub struct IncrementalMerkleProver {
    light: IncrementalMerkle,
    full: MerkleTree,
}

impl Default for IncrementalMerkleProver {
    fn default() -> Self {
        let light = IncrementalMerkle::default();
        let full = MerkleTree::create(&[], TREE_DEPTH);
        Self { light, full }
    }
}

impl IncrementalMerkleProver {
    pub fn ingest(&mut self, element: H256) -> H256 {
        self.light.ingest(element);
        self.full.push_leaf(element, TREE_DEPTH).unwrap();
        debug_assert_eq!(self.light.root(), self.full.hash());
        self.full.hash()
    }

    pub fn root(&self) -> H256 {
        self.full.hash()
    }

    pub fn count(&self) -> u32 {
        self.light.count()
    }

    pub fn prove(&self, index: usize) -> Result<Proof, ()> {
        if index > u32::MAX as usize {
            return Err(());
        }
        let (leaf, hashes) = self.full.generate_proof(index, TREE_DEPTH);
        let mut path = [H256::zero(); 32];
        path.copy_from_slice(&hashes[..32]);
        Ok(Proof { leaf, index, path })
    }

    pub fn verify(&self, proof: &Proof) -> Result<(), ()> {
        if verify_merkle_proof(
            proof.leaf,
            proof.path.as_ref(),
            TREE_DEPTH,
            proof.index,
            self.root(),
        ) {
            Ok(())
        } else {
            Err(())
        }
    }
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn it_test() {
        let mut tree = IncrementalMerkleProver::default();

        let elements: Vec<_> = (1..32).map(|i| H256::repeat_byte(i as u8)).collect();
        tree.ingest(elements[0]);
        tree.ingest(elements[1]);
        tree.ingest(elements[2]);

        assert_eq!(tree.count(), 3);

        let idx = 1;
        let proof = tree.prove(idx).unwrap();
        dbg!(&proof);
        tree.verify(&proof).unwrap();
    }
}
