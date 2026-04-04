use hyperlane_core::U256;
use solana_program::program_error::ProgramError;

use crate::{accounts::FeeData, error::Error};

/// Convert a U256 to u64, returning IntegerOverflow on failure.
fn try_u256_to_u64(val: U256) -> Result<u64, ProgramError> {
    val.try_into()
        .map_err(|_| ProgramError::from(Error::IntegerOverflow))
}

/// Compute the fee for a given amount based on the fee data.
///
/// All intermediate math uses U256 to avoid overflow. Since all inputs are
/// u64, no intermediate computation can exceed 256 bits. Final results are
/// safely converted back to u64 via `try_from` as defense-in-depth.
pub fn compute_fee(fee_data: &FeeData, amount: u64) -> Result<u64, ProgramError> {
    match fee_data {
        FeeData::Linear {
            max_fee,
            half_amount,
        } => {
            if *half_amount == 0 || *max_fee == 0 {
                return Ok(0);
            }
            // fee = min(max_fee, amount * max_fee / (2 * half_amount))
            let fee = U256::from(amount) * U256::from(*max_fee)
                / (U256::from(2) * U256::from(*half_amount));
            Ok(std::cmp::min(*max_fee, try_u256_to_u64(fee)?))
        }
        FeeData::Regressive {
            max_fee,
            half_amount,
        } => {
            if *half_amount == 0 || *max_fee == 0 {
                return Ok(0);
            }
            // fee = max_fee * amount / (half_amount + amount)
            let fee = U256::from(*max_fee) * U256::from(amount)
                / (U256::from(*half_amount) + U256::from(amount));
            Ok(std::cmp::min(*max_fee, try_u256_to_u64(fee)?))
        }
        FeeData::Progressive {
            max_fee,
            half_amount,
        } => {
            if *half_amount == 0 || *max_fee == 0 {
                return Ok(0);
            }
            // fee = max_fee * amount^2 / (half_amount^2 + amount^2)
            let amount_sq = U256::from(amount) * U256::from(amount);
            let half_sq = U256::from(*half_amount) * U256::from(*half_amount);
            let fee = U256::from(*max_fee) * amount_sq / (half_sq + amount_sq);
            Ok(std::cmp::min(*max_fee, try_u256_to_u64(fee)?))
        }
        FeeData::Routing => Err(Error::RoutingFeeNotDirectlyComputable.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use serde::Deserialize;

    fn de_str_u64<'de, D: serde::Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
        let v = serde_json::Value::deserialize(d)?;
        match v {
            serde_json::Value::Number(n) => n
                .as_u64()
                .ok_or_else(|| serde::de::Error::custom("not a u64")),
            serde_json::Value::String(s) => s.parse().map_err(serde::de::Error::custom),
            _ => Err(serde::de::Error::custom("expected number or string")),
        }
    }

    #[derive(Deserialize)]
    struct FeeVector {
        #[serde(deserialize_with = "de_str_u64")]
        max_fee: u64,
        #[serde(deserialize_with = "de_str_u64")]
        half_amount: u64,
        #[serde(deserialize_with = "de_str_u64")]
        amount: u64,
        #[serde(deserialize_with = "de_str_u64")]
        expected_fee: u64,
        description: String,
    }

    #[derive(Deserialize)]
    struct FeeGroup {
        vectors: Vec<FeeVector>,
    }

    #[derive(Deserialize)]
    struct FeeFixtures {
        linear: FeeGroup,
        progressive: FeeGroup,
        regressive: FeeGroup,
    }

    fn load_fixtures() -> FeeFixtures {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../vectors/fees.json");
        let data = std::fs::read_to_string(path).expect("failed to read fees.json");
        serde_json::from_str(&data).expect("failed to parse fees.json")
    }

    // ---- Shared fixture tests ----

    #[test]
    fn test_linear_fee_fixtures() {
        let fixtures = load_fixtures();
        for v in &fixtures.linear.vectors {
            let fee_data = FeeData::Linear {
                max_fee: v.max_fee,
                half_amount: v.half_amount,
            };
            assert_eq!(
                compute_fee(&fee_data, v.amount).unwrap(),
                v.expected_fee,
                "linear: {}",
                v.description
            );
        }
    }

    #[test]
    fn test_progressive_fee_fixtures() {
        let fixtures = load_fixtures();
        for v in &fixtures.progressive.vectors {
            let fee_data = FeeData::Progressive {
                max_fee: v.max_fee,
                half_amount: v.half_amount,
            };
            assert_eq!(
                compute_fee(&fee_data, v.amount).unwrap(),
                v.expected_fee,
                "progressive: {}",
                v.description
            );
        }
    }

    #[test]
    fn test_regressive_fee_fixtures() {
        let fixtures = load_fixtures();
        for v in &fixtures.regressive.vectors {
            let fee_data = FeeData::Regressive {
                max_fee: v.max_fee,
                half_amount: v.half_amount,
            };
            assert_eq!(
                compute_fee(&fee_data, v.amount).unwrap(),
                v.expected_fee,
                "regressive: {}",
                v.description
            );
        }
    }

    // ---- Rust-only edge case tests (zero params, u64::MAX, overflow) ----

    #[test]
    fn test_routing_returns_error() {
        assert!(compute_fee(&FeeData::Routing, 1000).is_err());
    }

    #[test]
    fn test_linear_fee_zero_half_amount() {
        let fee_data = FeeData::Linear {
            max_fee: 1000,
            half_amount: 0,
        };
        assert_eq!(compute_fee(&fee_data, 5000).unwrap(), 0);
    }

    #[test]
    fn test_large_amounts_no_overflow() {
        let fee_data = FeeData::Linear {
            max_fee: u64::MAX,
            half_amount: u64::MAX,
        };
        assert_eq!(compute_fee(&fee_data, u64::MAX).unwrap(), u64::MAX / 2);
    }

    #[test]
    fn test_linear_max_u64_amount() {
        let fee_data = FeeData::Linear {
            max_fee: 1_000_000,
            half_amount: 500_000,
        };
        assert_eq!(compute_fee(&fee_data, u64::MAX).unwrap(), 1_000_000);
    }

    #[test]
    fn test_linear_max_fee_u64_max() {
        let fee_data = FeeData::Linear {
            max_fee: u64::MAX,
            half_amount: 1000,
        };
        assert_eq!(compute_fee(&fee_data, 1000).unwrap(), u64::MAX / 2);
    }

    #[test]
    fn test_regressive_max_u64_amount() {
        let fee_data = FeeData::Regressive {
            max_fee: 1_000_000,
            half_amount: 500_000,
        };
        assert_eq!(compute_fee(&fee_data, u64::MAX).unwrap(), 999_999);
    }

    #[test]
    fn test_regressive_max_u64_all() {
        let fee_data = FeeData::Regressive {
            max_fee: u64::MAX,
            half_amount: u64::MAX,
        };
        assert_eq!(compute_fee(&fee_data, u64::MAX).unwrap(), u64::MAX / 2);
    }

    #[test]
    fn test_progressive_max_u64_amount() {
        let fee_data = FeeData::Progressive {
            max_fee: 1_000_000,
            half_amount: 500_000,
        };
        assert_eq!(compute_fee(&fee_data, u64::MAX).unwrap(), 999_999);
    }

    #[test]
    fn test_progressive_max_u64_all() {
        let fee_data = FeeData::Progressive {
            max_fee: u64::MAX,
            half_amount: u64::MAX,
        };
        assert_eq!(compute_fee(&fee_data, u64::MAX).unwrap(), u64::MAX / 2);
    }

    #[test]
    fn test_regressive_zero_half_amount() {
        let fee_data = FeeData::Regressive {
            max_fee: 1000,
            half_amount: 0,
        };
        assert_eq!(compute_fee(&fee_data, 5000).unwrap(), 0);
    }

    #[test]
    fn test_progressive_zero_half_amount() {
        let fee_data = FeeData::Progressive {
            max_fee: 1000,
            half_amount: 0,
        };
        assert_eq!(compute_fee(&fee_data, 5000).unwrap(), 0);
    }

    #[test]
    fn test_progressive_large_ratio_approaches_max() {
        let fee_data = FeeData::Progressive {
            max_fee: 1000,
            half_amount: 100,
        };
        let fee = compute_fee(&fee_data, 10_000).unwrap();
        assert!((999..=1000).contains(&fee));
    }

    #[test]
    fn test_linear_max_fee_zero() {
        let fee_data = FeeData::Linear {
            max_fee: 0,
            half_amount: 5000,
        };
        assert_eq!(compute_fee(&fee_data, 5000).unwrap(), 0);
    }

    #[test]
    fn test_regressive_max_fee_zero() {
        let fee_data = FeeData::Regressive {
            max_fee: 0,
            half_amount: 5000,
        };
        assert_eq!(compute_fee(&fee_data, 5000).unwrap(), 0);
    }

    #[test]
    fn test_progressive_former_double_overflow() {
        let fee_data = FeeData::Progressive {
            max_fee: u64::MAX,
            half_amount: 1u64 << 33,
        };
        assert_eq!(compute_fee(&fee_data, 1u64 << 33).unwrap(), u64::MAX / 2);
    }

    #[test]
    fn test_progressive_max_fee_zero() {
        let fee_data = FeeData::Progressive {
            max_fee: 0,
            half_amount: 5000,
        };
        assert_eq!(compute_fee(&fee_data, 5000).unwrap(), 0);
    }
}
