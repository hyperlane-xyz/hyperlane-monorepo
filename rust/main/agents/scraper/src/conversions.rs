use num_bigint::{BigInt, Sign};
use sea_orm::prelude::BigDecimal;

use hyperlane_core::U256;

pub fn u256_to_decimal(v: U256) -> BigDecimal {
    let mut buf = [0u8; 32];
    v.to_little_endian(&mut buf);
    BigDecimal::from(BigInt::from_bytes_le(Sign::Plus, &buf as &[u8]))
}

pub fn decimal_to_u256(v: BigDecimal) -> U256 {
    let (i, _) = v.into_bigint_and_exponent();
    let (_, b) = i.to_bytes_le();
    U256::from_little_endian(&b)
}

#[cfg(test)]
mod tests {
    use hyperlane_core::U256;

    use crate::conversions::{decimal_to_u256, u256_to_decimal};

    #[test]
    fn test() {
        // given
        let u = U256::from_dec_str(
            "76418673493495739447102571088210420170780567439841463646292940247514478199569",
        )
        .unwrap();

        // when
        let r = decimal_to_u256(u256_to_decimal(u));

        // then
        assert_eq!(u, r);
    }
}
