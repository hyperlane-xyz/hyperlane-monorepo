use sha3::{digest::Update, Digest, Keccak256};

use crate::H256;

/// A lightweight incremental merkle, suitable for running on-chain. Stores O
/// (1) data
pub mod incremental;
/// A full incremental merkle. Suitable for running off-chain.
pub mod merkle;
/// Utilities for manipulating proofs to reflect sparse merkle trees.
pub mod sparse;

mod zero_hashes;
pub use zero_hashes::{TREE_DEPTH, ZERO_HASHES};

const EMPTY_SLICE: &[H256] = &[];

pub(super) fn hash_concat(left: impl AsRef<[u8]>, right: impl AsRef<[u8]>) -> H256 {
    H256::from_slice(
        Keccak256::new()
            .chain(left)
            .chain(right)
            .finalize()
            .as_slice(),
    )
}

/// The root of an empty tree
pub const INITIAL_ROOT: H256 = H256([
    39, 174, 91, 160, 141, 114, 145, 201, 108, 140, 189, 220, 193, 72, 191, 72, 166, 214, 140, 121,
    116, 185, 67, 86, 245, 55, 84, 239, 97, 113, 215, 87,
]);

#[cfg(test)]
mod test {
    use super::*;

    fn compute_zero_hashes() -> [H256; TREE_DEPTH + 1] {
        // Implementation previously used in the `lazy_static!` macro for `ZERO_HASHES`
        let mut hashes = [H256::zero(); TREE_DEPTH + 1];
        for i in 0..TREE_DEPTH {
            hashes[i + 1] = hash_concat(hashes[i], hashes[i]);
        }
        hashes
    }

    #[test]
    fn it_calculates_the_initial_root() {
        assert_eq!(
            INITIAL_ROOT,
            "0x27ae5ba08d7291c96c8cbddcc148bf48a6d68c7974b94356f53754ef6171d757"
                .parse()
                .unwrap()
        );
    }

    #[test]
    fn it_prints_zero_hashes_items() {
        assert_eq!(zero_hashes::ZERO_HASHES, compute_zero_hashes());
    }

    #[test]
    fn it_computes_initial_root() {
        assert_eq!(
            incremental::IncrementalMerkle::default().root(),
            INITIAL_ROOT
        );
    }
}
