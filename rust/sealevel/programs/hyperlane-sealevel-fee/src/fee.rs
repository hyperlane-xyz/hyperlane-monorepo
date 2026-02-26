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

    #[test]
    fn test_linear_fee_basic() {
        let fee_data = FeeData::Linear {
            max_fee: 1000,
            half_amount: 5000,
        };
        // fee = min(1000, 5000 * 1000 / (2 * 5000)) = min(1000, 500) = 500
        assert_eq!(compute_fee(&fee_data, 5000).unwrap(), 500);
    }

    #[test]
    fn test_linear_fee_capped() {
        let fee_data = FeeData::Linear {
            max_fee: 1000,
            half_amount: 5000,
        };
        // fee = min(1000, 20000 * 1000 / 10000) = min(1000, 2000) = 1000
        assert_eq!(compute_fee(&fee_data, 20000).unwrap(), 1000);
    }

    #[test]
    fn test_linear_fee_zero_amount() {
        let fee_data = FeeData::Linear {
            max_fee: 1000,
            half_amount: 5000,
        };
        assert_eq!(compute_fee(&fee_data, 0).unwrap(), 0);
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
    fn test_regressive_fee_basic() {
        let fee_data = FeeData::Regressive {
            max_fee: 1000,
            half_amount: 5000,
        };
        // fee = 1000 * 5000 / (5000 + 5000) = 500
        assert_eq!(compute_fee(&fee_data, 5000).unwrap(), 500);
    }

    #[test]
    fn test_regressive_fee_approaches_max() {
        let fee_data = FeeData::Regressive {
            max_fee: 1000,
            half_amount: 5000,
        };
        // fee = 1000 * 1000000 / (5000 + 1000000) = ~995
        assert_eq!(compute_fee(&fee_data, 1_000_000).unwrap(), 995);
    }

    #[test]
    fn test_progressive_fee_basic() {
        let fee_data = FeeData::Progressive {
            max_fee: 1000,
            half_amount: 5000,
        };
        // fee = 1000 * 5000^2 / (5000^2 + 5000^2) = 500
        assert_eq!(compute_fee(&fee_data, 5000).unwrap(), 500);
    }

    #[test]
    fn test_progressive_fee_small_amount() {
        let fee_data = FeeData::Progressive {
            max_fee: 1000,
            half_amount: 5000,
        };
        // fee = 1000 * 100^2 / (5000^2 + 100^2) = 1000 * 10000 / 25010000 ≈ 0
        assert_eq!(compute_fee(&fee_data, 100).unwrap(), 0);
    }

    #[test]
    fn test_routing_returns_error() {
        assert!(compute_fee(&FeeData::Routing, 1000).is_err());
    }

    #[test]
    fn test_large_amounts_no_overflow() {
        let fee_data = FeeData::Linear {
            max_fee: u64::MAX,
            half_amount: u64::MAX,
        };
        // fee = min(MAX, MAX * MAX / (2 * MAX)) = min(MAX, MAX/2)
        assert_eq!(compute_fee(&fee_data, u64::MAX).unwrap(), u64::MAX / 2);
    }

    // ---- Overflow / edge case tests ----

    #[test]
    fn test_linear_max_u64_amount() {
        let fee_data = FeeData::Linear {
            max_fee: 1_000_000,
            half_amount: 500_000,
        };
        // amount=u64::MAX >> 2*half_amount, so fee is capped at max_fee
        assert_eq!(compute_fee(&fee_data, u64::MAX).unwrap(), 1_000_000);
    }

    #[test]
    fn test_linear_max_fee_u64_max() {
        let fee_data = FeeData::Linear {
            max_fee: u64::MAX,
            half_amount: 1000,
        };
        // Large max_fee, moderate amount: fee = amount * MAX / 2000
        // amount=1000 -> fee = 1000 * MAX / 2000 = MAX/2
        assert_eq!(compute_fee(&fee_data, 1000).unwrap(), u64::MAX / 2);
    }

    #[test]
    fn test_regressive_max_u64_amount() {
        let fee_data = FeeData::Regressive {
            max_fee: 1_000_000,
            half_amount: 500_000,
        };
        // fee = 1_000_000 * u64::MAX / (500_000 + u64::MAX) ≈ 999_999
        // (approaches max_fee but never reaches it)
        let fee = compute_fee(&fee_data, u64::MAX).unwrap();
        assert_eq!(fee, 999_999);
    }

    #[test]
    fn test_regressive_max_u64_all() {
        let fee_data = FeeData::Regressive {
            max_fee: u64::MAX,
            half_amount: u64::MAX,
        };
        // fee = MAX * MAX / (MAX + MAX) = MAX/2
        assert_eq!(compute_fee(&fee_data, u64::MAX).unwrap(), u64::MAX / 2);
    }

    #[test]
    fn test_progressive_max_u64_amount() {
        let fee_data = FeeData::Progressive {
            max_fee: 1_000_000,
            half_amount: 500_000,
        };
        // fee approaches max_fee for large amounts; U256 gives exact truncation
        assert_eq!(compute_fee(&fee_data, u64::MAX).unwrap(), 999_999);
    }

    #[test]
    fn test_progressive_max_u64_all() {
        let fee_data = FeeData::Progressive {
            max_fee: u64::MAX,
            half_amount: u64::MAX,
        };
        // fee = MAX * MAX^2 / (MAX^2 + MAX^2) = MAX/2
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

    // ---- Rounding / edge behavior tests ----

    #[test]
    fn test_linear_tiny_amount_rounds_to_zero() {
        let fee_data = FeeData::Linear {
            max_fee: 1000,
            half_amount: 5000,
        };
        // fee = 1 * 1000 / 10000 = 0 (integer division rounds down)
        assert_eq!(compute_fee(&fee_data, 1).unwrap(), 0);
    }

    #[test]
    fn test_progressive_large_ratio_approaches_max() {
        let fee_data = FeeData::Progressive {
            max_fee: 1000,
            half_amount: 100,
        };
        // amount=10_000 >> half_amount=100, so fee should be very close to max_fee
        // fee = 1000 * 10000^2 / (100^2 + 10000^2) = 1000 * 1e8 / (1e4 + 1e8) ≈ 999
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
        // Previously overflowed u128; U256 handles it correctly.
        // amount == half_amount, so fee = max_fee * a^2 / (a^2 + a^2) = max_fee / 2
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
