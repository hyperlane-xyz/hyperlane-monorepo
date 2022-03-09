use std::fmt::{self};

use ethers::types::U256;
use serde::{Deserialize, Serialize};

/// A thin wrapper around ethers U256 to support en-/decoding
#[derive(Copy, Clone, Debug, Eq, PartialEq, Serialize, Deserialize, PartialOrd)]
pub struct AbacusU256(U256);

impl fmt::Display for AbacusU256 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl From<&[u8; 32]> for AbacusU256 {
    fn from(bytes: &[u8; 32]) -> AbacusU256 {
        AbacusU256(U256::from_big_endian(bytes))
    }
}

impl From<U256> for AbacusU256 {
    fn from(val: U256) -> AbacusU256 {
        AbacusU256(val)
    }
}

impl From<AbacusU256> for U256 {
    fn from(val: AbacusU256) -> U256 {
        val.0
    }
}

impl AbacusU256 {
    /// Return the byte array for the number
    pub fn to_bytes(&self) -> [u8; 32] {
        let mut index_bytes = [0u8; 32];
        self.0.to_big_endian(&mut index_bytes);

        index_bytes
    }
}
