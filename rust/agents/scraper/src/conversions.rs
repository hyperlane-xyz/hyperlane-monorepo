use num_bigint::{BigInt, Sign};
use sea_orm::prelude::BigDecimal;

use hyperlane_core::{H256, U256};

/// Convert a hex string (without 0x prefix) to a H256. This handles the case
/// where it is actually as H160 and will correctly return a H256 with the most
/// significant bits as zero.
pub fn parse_h256<T: AsRef<[u8]>>(data: T) -> eyre::Result<H256> {
    if data.as_ref().len() == 40 {
        Ok(H256(hex::parse_h256_raw::<40>(
            data.as_ref().try_into().unwrap(),
        )?))
    } else {
        Ok(H256(hex::parse_h256_raw::<64>(data.as_ref().try_into()?)?))
    }
}

/// Formats a H256 as a lowercase hex string without a 0x prefix. This will
/// correctly determine if the data fits within a H160 (enough of the most
/// significant bits are zero) and will write it as such. This will pad with
/// zeros to fit either a H256 of H160 depending.
pub fn format_h256(data: &H256) -> String {
    if hex::is_h160(data.as_fixed_bytes()) {
        hex::format_h160_raw(data.as_fixed_bytes()[12..32].try_into().unwrap())
    } else {
        hex::format_h256_raw(data.as_fixed_bytes())
    }
}

pub fn u256_to_decimal(v: U256) -> BigDecimal {
    let mut buf = [0u8; 32];
    v.to_little_endian(&mut buf);
    BigDecimal::from(BigInt::from_bytes_le(Sign::Plus, &buf as &[u8]))
}
