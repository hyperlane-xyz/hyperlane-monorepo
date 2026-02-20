use solana_program::program_error::ProgramError;

use crate::{accounts::FeeData, error::Error};

/// Safely convert u128 to u64, returning IntegerOverflow on failure.
fn try_u128_to_u64(val: u128) -> Result<u64, ProgramError> {
    u64::try_from(val).map_err(|_| ProgramError::from(Error::IntegerOverflow))
}

/// Compute the fee for a given amount based on the fee data.
///
/// All intermediate math uses u128 to avoid overflow. Final results are
/// safely converted back to u64 via `try_from`. Returns an error if the
/// intermediate result overflows u64 (should not happen when max_fee is
/// a reasonable u64 value, but guarded defensively).
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
            let numerator = (amount as u128) * (*max_fee as u128);
            let denominator = 2u128 * (*half_amount as u128);
            let fee = try_u128_to_u64(numerator / denominator)?;
            Ok(std::cmp::min(*max_fee, fee))
        }
        FeeData::Regressive {
            max_fee,
            half_amount,
        } => {
            if *half_amount == 0 || *max_fee == 0 {
                return Ok(0);
            }
            // fee = max_fee * amount / (half_amount + amount)
            let numerator = (*max_fee as u128) * (amount as u128);
            let denominator = (*half_amount as u128) + (amount as u128);
            let fee = try_u128_to_u64(numerator / denominator)?;
            Ok(std::cmp::min(*max_fee, fee))
        }
        FeeData::Progressive {
            max_fee,
            half_amount,
        } => {
            if *half_amount == 0 || *max_fee == 0 {
                return Ok(0);
            }
            // fee = max_fee * amount^2 / (half_amount^2 + amount^2)
            let amount_sq = (amount as u128) * (amount as u128);
            let half_sq = (*half_amount as u128) * (*half_amount as u128);
            let denominator = half_sq
                .checked_add(amount_sq)
                .ok_or(ProgramError::from(Error::IntegerOverflow))?;
            // max_fee * amount_sq can overflow u128 for extreme values.
            // Use checked_mul; on overflow, compute via the complement:
            //   fee = max_fee - max_fee * half_sq / denominator
            let fee = match (*max_fee as u128).checked_mul(amount_sq) {
                Some(numerator) => try_u128_to_u64(numerator / denominator)?,
                None => {
                    // Complement: fee = max_fee - max_fee * half_sq / denominator
                    // max_fee * half_sq could also overflow, so use checked_mul again.
                    let complement = match (*max_fee as u128).checked_mul(half_sq) {
                        Some(num) => try_u128_to_u64(num / denominator)?,
                        // Both overflow: amount and half_amount are both huge,
                        // ratio ≈ 0.5, so fee ≈ max_fee / 2.
                        // Fall back to: amount_sq / denominator ≈ ratio, compute with scaling.
                        None => {
                            // Scale down: divide both squares by a common factor.
                            // ratio = amount_sq / (half_sq + amount_sq)
                            // Use the fact that amount_sq / denominator < 1:
                            // Multiply max_fee by (amount_sq >> 64) / (denominator >> 64)
                            let shift_amt = (amount_sq >> 64) as u64;
                            let shift_den = (denominator >> 64) as u64;
                            if shift_den == 0 {
                                *max_fee
                            } else {
                                (*max_fee as u128 * shift_amt as u128 / shift_den as u128) as u64
                            }
                        }
                    };
                    max_fee.saturating_sub(complement)
                }
            };
            Ok(std::cmp::min(*max_fee, fee))
        }
        FeeData::Routing => {
            // Routing delegates to per-domain fee accounts; should never be called directly.
            Ok(0)
        }
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
    fn test_routing_returns_zero() {
        assert_eq!(compute_fee(&FeeData::Routing, 1000).unwrap(), 0);
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
        // fee approaches max_fee for large amounts
        let fee = compute_fee(&fee_data, u64::MAX).unwrap();
        assert!(fee > 999_999 && fee <= 1_000_000);
    }

    #[test]
    fn test_progressive_max_u64_all() {
        let fee_data = FeeData::Progressive {
            max_fee: u64::MAX,
            half_amount: u64::MAX,
        };
        // half_sq + amount_sq overflows u128, so this returns IntegerOverflow
        assert!(compute_fee(&fee_data, u64::MAX).is_err());
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
}
