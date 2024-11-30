use std::str::FromStr;

use num_bigint::{BigInt, Sign};
use sea_orm::prelude::{BigDecimal, Decimal};

use hyperlane_core::U256;

pub fn u256_to_decimal(v: U256) -> Decimal {
    let mut buf = [0u8; 32];
    v.to_little_endian(&mut buf);
    let big_dec = &BigDecimal::from(BigInt::from_bytes_le(Sign::Plus, &buf as &[u8])).to_string();
    Decimal::from_str(big_dec).unwrap()
}
