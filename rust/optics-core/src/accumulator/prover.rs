use crate::accumulator::{
    incremental::IncrementalMerkle,
    merkle::{verify_merkle_proof, MerkleTree},
    TREE_DEPTH,
};

use ethers_core::types::H256;

#[derive(Debug, Clone, Copy)]
pub struct Proof {
    leaf: H256,
    index: usize,
    path: [H256; TREE_DEPTH],
}

#[derive(Debug)]
pub struct Prover {
    light: IncrementalMerkle,
    full: MerkleTree,
}

impl Default for Prover {
    fn default() -> Self {
        let light = IncrementalMerkle::default();
        let full = MerkleTree::create(&[], TREE_DEPTH);
        Self { light, full }
    }
}

impl Prover {
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
        let mut tree = Prover::default();

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
