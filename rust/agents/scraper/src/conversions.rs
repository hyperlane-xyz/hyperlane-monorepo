use num_bigint::{BigInt, Sign};
use sea_orm::prelude::BigDecimal;

use hyperlane_core::{H256, U256};

// Creates a big-endian hex representation of the address
pub fn address_to_bytes(data: &H256) -> Vec<u8> {
    if hex::is_h160(data.as_fixed_bytes()) {
        // take the last 20 bytes
        data.as_fixed_bytes()[12..32].into()
    } else {
        h256_to_bytes(data)
    }
}

// Creates a big-endian hex representation of the address
pub fn bytes_to_address(data: Vec<u8>) -> eyre::Result<H256> {
    if (data.len() != 20) && (data.len() != 32) {
        return Err(eyre::eyre!("Invalid address length"));
    }
    if data.len() == 20 {
        let mut prefix = vec![0; 12];
        prefix.extend(data);
        Ok(H256::from_slice(&prefix[..]))
    } else {
        Ok(H256::from_slice(&data[..]))
    }
}

// Creates a big-endian hex representation of the address hash
pub fn h256_to_bytes(data: &H256) -> Vec<u8> {
    data.as_fixed_bytes().as_slice().into()
}

pub fn u256_to_decimal(v: U256) -> BigDecimal {
    let mut buf = [0u8; 32];
    v.to_little_endian(&mut buf);
    BigDecimal::from(BigInt::from_bytes_le(Sign::Plus, &buf as &[u8]))
}
