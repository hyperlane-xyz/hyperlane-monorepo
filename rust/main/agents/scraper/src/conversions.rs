use hyperlane_core::U256;
use num_bigint::{BigInt, Sign};
use sea_orm::prelude::BigDecimal;

pub fn u256_to_decimal(v: U256) -> BigDecimal {
    let mut buf = [0u8; 32];
    v.to_little_endian(&mut buf);
    BigDecimal::from(BigInt::from_bytes_le(Sign::Plus, &buf as &[u8]))
}
