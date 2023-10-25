use hyperlane_core::{H256, H512};

use std::cmp;

pub fn h256_to_h512(v: H256) -> H512 {
    let mut result: [u8; 64] = [0; 64];
    let vec = v.0.as_slice();
    let start_point = cmp::max(0, 32 - vec.len());
    result[start_point..32].copy_from_slice(vec);

    H512::from_slice(&result)
}
