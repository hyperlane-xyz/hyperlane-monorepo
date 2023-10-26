use hyperlane_core::{H160, H256, H512};
use std::cmp;

/// Convert H256 to H512
pub fn h256_to_h512(v: H256) -> H512 {
    let mut result: [u8; 64] = [0; 64];
    let vec = v.0.as_slice();
    let start_point = cmp::max(0, 32 - vec.len());
    result[start_point..32].copy_from_slice(vec);

    H512::from_slice(&result)
}

/// Convert H256 to H160
pub fn h256_to_h160(v: H256) -> H160 {
    let mut result = [0u8; 20];

    result.copy_from_slice(&v.0[12..]);
    H160::from_slice(&result)
}

/// Convert H160 to H256
pub fn h160_to_h256(v: H160) -> H256 {
    let mut result = [0u8; 32];
    result[12..].copy_from_slice(v.as_bytes());

    H256::from_slice(&result)
}
