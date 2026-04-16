use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::U256;
use solana_program::program_error::ProgramError;

use crate::error::Error;

/// Parameters for fee curve computation.
#[derive(BorshDeserialize, BorshSerialize, Clone, Debug, Default, PartialEq)]
pub struct FeeParams {
    /// Maximum fee that can be charged, in local token units.
    pub max_fee: u64,
    /// The transfer amount at which fee reaches half of max_fee.
    pub half_amount: u64,
}

/// Fee computation strategy. Each variant uses a different curve shape.
#[derive(BorshDeserialize, BorshSerialize, Clone, Debug, PartialEq)]
pub enum FeeDataStrategy {
    /// fee = min(max_fee, amount * max_fee / (2 * half_amount))
    Linear(FeeParams),
    /// fee = max_fee * amount / (half_amount + amount)
    Regressive(FeeParams),
    /// fee = max_fee * amount^2 / (half_amount^2 + amount^2)
    Progressive(FeeParams),
}

impl Default for FeeDataStrategy {
    fn default() -> Self {
        Self::Linear(FeeParams::default())
    }
}

impl FeeDataStrategy {
    /// Computes the fee for the given transfer amount.
    /// All arithmetic uses U256 intermediates. Results rounded down.
    /// Returns 0 when max_fee or half_amount is 0.
    pub fn compute_fee(&self, amount: u64) -> Result<u64, ProgramError> {
        match self {
            Self::Linear(p) => compute_linear(
                U256::from(p.max_fee),
                U256::from(p.half_amount),
                U256::from(amount),
            ),
            Self::Regressive(p) => compute_regressive(
                U256::from(p.max_fee),
                U256::from(p.half_amount),
                U256::from(amount),
            ),
            Self::Progressive(p) => compute_progressive(
                U256::from(p.max_fee),
                U256::from(p.half_amount),
                U256::from(amount),
            ),
        }
    }

    /// Returns a reference to the inner FeeParams.
    pub fn params(&self) -> &FeeParams {
        match self {
            Self::Linear(p) | Self::Regressive(p) | Self::Progressive(p) => p,
        }
    }
}

/// Linear: fee = min(max_fee, amount * max_fee / (2 * half_amount))
fn compute_linear(max_fee: U256, half_amount: U256, amount: U256) -> Result<u64, ProgramError> {
    if max_fee.is_zero() || half_amount.is_zero() {
        return Ok(0);
    }

    let denominator = U256::from(2) * half_amount;
    let fee = amount * max_fee / denominator;
    let capped = core::cmp::min(fee, max_fee);

    capped
        .try_into()
        .map_err(|_| Error::FeeComputationOverflow.into())
}

/// Regressive: fee = max_fee * amount / (half_amount + amount)
fn compute_regressive(max_fee: U256, half_amount: U256, amount: U256) -> Result<u64, ProgramError> {
    if max_fee.is_zero() || half_amount.is_zero() {
        return Ok(0);
    }

    let fee = max_fee * amount / (half_amount + amount);

    fee.try_into()
        .map_err(|_| Error::FeeComputationOverflow.into())
}

/// Progressive: fee = max_fee * amount^2 / (half_amount^2 + amount^2)
fn compute_progressive(
    max_fee: U256,
    half_amount: U256,
    amount: U256,
) -> Result<u64, ProgramError> {
    if max_fee.is_zero() || half_amount.is_zero() {
        return Ok(0);
    }

    let amount_sq = amount * amount;
    let half_sq = half_amount * half_amount;
    let denominator = half_sq + amount_sq;

    if denominator.is_zero() {
        return Ok(0);
    }

    let fee = max_fee * amount_sq / denominator;

    fee.try_into()
        .map_err(|_| Error::FeeComputationOverflow.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- Linear curve tests ---

    #[test]
    fn test_linear_zero_amount() {
        let strategy = FeeDataStrategy::Linear(FeeParams {
            max_fee: 1000,
            half_amount: 500,
        });
        assert_eq!(strategy.compute_fee(0).unwrap(), 0);
    }

    #[test]
    fn test_linear_at_half_amount() {
        // fee = 500 * 1000 / (2 * 500) = 500
        let strategy = FeeDataStrategy::Linear(FeeParams {
            max_fee: 1000,
            half_amount: 500,
        });
        assert_eq!(strategy.compute_fee(500).unwrap(), 500);
    }

    #[test]
    fn test_linear_at_double_half_amount() {
        // fee = min(1000, 1000 * 1000 / 1000) = 1000
        let strategy = FeeDataStrategy::Linear(FeeParams {
            max_fee: 1000,
            half_amount: 500,
        });
        assert_eq!(strategy.compute_fee(1000).unwrap(), 1000);
    }

    #[test]
    fn test_linear_capped_at_max_fee() {
        let strategy = FeeDataStrategy::Linear(FeeParams {
            max_fee: 1000,
            half_amount: 500,
        });
        assert_eq!(strategy.compute_fee(5000).unwrap(), 1000);
        assert_eq!(strategy.compute_fee(u64::MAX).unwrap(), 1000);
    }

    #[test]
    fn test_linear_small_amount() {
        // fee = 100 * 1000 / 1000 = 100
        let strategy = FeeDataStrategy::Linear(FeeParams {
            max_fee: 1000,
            half_amount: 500,
        });
        assert_eq!(strategy.compute_fee(100).unwrap(), 100);
    }

    #[test]
    fn test_linear_rounds_down() {
        // fee = 1 * 1000 / (2 * 3) = 1000 / 6 = 166 (rounded down)
        let strategy = FeeDataStrategy::Linear(FeeParams {
            max_fee: 1000,
            half_amount: 3,
        });
        assert_eq!(strategy.compute_fee(1).unwrap(), 166);
    }

    // --- Regressive curve tests ---

    #[test]
    fn test_regressive_zero_amount() {
        let strategy = FeeDataStrategy::Regressive(FeeParams {
            max_fee: 1000,
            half_amount: 500,
        });
        assert_eq!(strategy.compute_fee(0).unwrap(), 0);
    }

    #[test]
    fn test_regressive_at_half_amount() {
        // fee = 1000 * 500 / (500 + 500) = 500
        let strategy = FeeDataStrategy::Regressive(FeeParams {
            max_fee: 1000,
            half_amount: 500,
        });
        assert_eq!(strategy.compute_fee(500).unwrap(), 500);
    }

    #[test]
    fn test_regressive_approaches_max() {
        // fee = 1000 * 1_000_000 / (500 + 1_000_000) = 999
        let strategy = FeeDataStrategy::Regressive(FeeParams {
            max_fee: 1000,
            half_amount: 500,
        });
        assert_eq!(strategy.compute_fee(1_000_000).unwrap(), 999);
    }

    #[test]
    fn test_regressive_large_amount() {
        // Asymptotic: fee approaches but never reaches max_fee
        // fee = 1000 * u64::MAX / (500 + u64::MAX) = 999
        let strategy = FeeDataStrategy::Regressive(FeeParams {
            max_fee: 1000,
            half_amount: 500,
        });
        let fee = strategy.compute_fee(u64::MAX).unwrap();
        assert_eq!(fee, 999);
    }

    #[test]
    fn test_regressive_small_amount() {
        // fee = 1000 * 10 / (500 + 10) = 19
        let strategy = FeeDataStrategy::Regressive(FeeParams {
            max_fee: 1000,
            half_amount: 500,
        });
        assert_eq!(strategy.compute_fee(10).unwrap(), 19);
    }

    // --- Progressive curve tests ---

    #[test]
    fn test_progressive_zero_amount() {
        let strategy = FeeDataStrategy::Progressive(FeeParams {
            max_fee: 1000,
            half_amount: 500,
        });
        assert_eq!(strategy.compute_fee(0).unwrap(), 0);
    }

    #[test]
    fn test_progressive_at_half_amount() {
        // fee = 1000 * 500^2 / (500^2 + 500^2) = 500
        let strategy = FeeDataStrategy::Progressive(FeeParams {
            max_fee: 1000,
            half_amount: 500,
        });
        assert_eq!(strategy.compute_fee(500).unwrap(), 500);
    }

    #[test]
    fn test_progressive_small_amount() {
        // fee = 1000 * 100 / (250000 + 100) = 0
        let strategy = FeeDataStrategy::Progressive(FeeParams {
            max_fee: 1000,
            half_amount: 500,
        });
        assert_eq!(strategy.compute_fee(10).unwrap(), 0);
    }

    #[test]
    fn test_progressive_large_amount() {
        // Asymptotic: fee approaches but never reaches max_fee (integer division rounds down)
        // fee = 1000 * u64::MAX^2 / (500^2 + u64::MAX^2) = 999
        let strategy = FeeDataStrategy::Progressive(FeeParams {
            max_fee: 1000,
            half_amount: 500,
        });
        let fee = strategy.compute_fee(u64::MAX).unwrap();
        assert_eq!(fee, 999);
    }

    #[test]
    fn test_progressive_moderate_amount() {
        // fee = 1000 * 1000^2 / (500^2 + 1000^2) = 1_000_000_000 / 1_250_000 = 800
        let strategy = FeeDataStrategy::Progressive(FeeParams {
            max_fee: 1000,
            half_amount: 500,
        });
        assert_eq!(strategy.compute_fee(1000).unwrap(), 800);
    }

    // --- Fee rate property tests (EVM parity) ---

    #[test]
    fn test_regressive_continuously_decreasing_fee_rate() {
        let strategy = FeeDataStrategy::Regressive(FeeParams {
            max_fee: 1_000_000,
            half_amount: 1_000_000,
        });
        // Start with amounts large enough that integer rounding doesn't dominate
        let amounts: Vec<u64> = vec![100_000, 500_000, 1_000_000, 5_000_000, 10_000_000];
        let mut prev_rate = u128::MAX;
        for amount in amounts {
            let fee = strategy.compute_fee(amount).unwrap();
            let rate = (fee as u128) * 1_000_000_000 / (amount as u128);
            assert!(
                rate <= prev_rate,
                "Regressive rate increased: amount={}, fee={}, rate={}, prev={}",
                amount,
                fee,
                rate,
                prev_rate
            );
            prev_rate = rate;
        }
    }

    #[test]
    fn test_progressive_increasing_fee_rate_before_half() {
        let strategy = FeeDataStrategy::Progressive(FeeParams {
            max_fee: 1_000_000,
            half_amount: 1_000_000,
        });
        let amounts: Vec<u64> = vec![1000, 10_000, 100_000, 500_000, 1_000_000];
        let mut prev_rate = 0u128;
        for amount in amounts {
            let fee = strategy.compute_fee(amount).unwrap();
            let rate = (fee as u128) * 1_000_000_000 / (amount as u128);
            assert!(
                rate >= prev_rate,
                "Progressive rate decreased before half: amount={}, fee={}, rate={}, prev={}",
                amount,
                fee,
                rate,
                prev_rate
            );
            prev_rate = rate;
        }
    }

    #[test]
    fn test_progressive_decreasing_fee_rate_after_half() {
        let strategy = FeeDataStrategy::Progressive(FeeParams {
            max_fee: 1_000_000,
            half_amount: 1_000_000,
        });
        let amounts: Vec<u64> = vec![1_000_000, 2_000_000, 5_000_000, 10_000_000];
        let mut prev_rate = u128::MAX;
        for amount in amounts {
            let fee = strategy.compute_fee(amount).unwrap();
            let rate = (fee as u128) * 1_000_000_000 / (amount as u128);
            assert!(
                rate <= prev_rate,
                "Progressive rate increased after half: amount={}, fee={}, rate={}, prev={}",
                amount,
                fee,
                rate,
                prev_rate
            );
            prev_rate = rate;
        }
    }

    // --- Edge case tests (all curves) ---

    #[test]
    fn test_zero_max_fee_all_curves() {
        let params = FeeParams {
            max_fee: 0,
            half_amount: 500,
        };
        assert_eq!(
            FeeDataStrategy::Linear(params.clone())
                .compute_fee(1000)
                .unwrap(),
            0
        );
        assert_eq!(
            FeeDataStrategy::Regressive(params.clone())
                .compute_fee(1000)
                .unwrap(),
            0
        );
        assert_eq!(
            FeeDataStrategy::Progressive(params.clone())
                .compute_fee(1000)
                .unwrap(),
            0
        );
    }

    #[test]
    fn test_zero_half_amount_all_curves() {
        let params = FeeParams {
            max_fee: 1000,
            half_amount: 0,
        };
        assert_eq!(
            FeeDataStrategy::Linear(params.clone())
                .compute_fee(1000)
                .unwrap(),
            0
        );
        assert_eq!(
            FeeDataStrategy::Regressive(params.clone())
                .compute_fee(1000)
                .unwrap(),
            0
        );
        assert_eq!(
            FeeDataStrategy::Progressive(params.clone())
                .compute_fee(1000)
                .unwrap(),
            0
        );
    }

    #[test]
    fn test_both_zero_all_curves() {
        let params = FeeParams {
            max_fee: 0,
            half_amount: 0,
        };
        assert_eq!(
            FeeDataStrategy::Linear(params.clone())
                .compute_fee(100)
                .unwrap(),
            0
        );
        assert_eq!(
            FeeDataStrategy::Regressive(params.clone())
                .compute_fee(100)
                .unwrap(),
            0
        );
        assert_eq!(
            FeeDataStrategy::Progressive(params.clone())
                .compute_fee(100)
                .unwrap(),
            0
        );
    }

    #[test]
    fn test_u64_max_params() {
        let params = FeeParams {
            max_fee: u64::MAX,
            half_amount: u64::MAX,
        };
        // All curves at amount=half: fee = max_fee/2
        assert_eq!(
            FeeDataStrategy::Linear(params.clone())
                .compute_fee(u64::MAX)
                .unwrap(),
            u64::MAX / 2
        );
        assert_eq!(
            FeeDataStrategy::Regressive(params.clone())
                .compute_fee(u64::MAX)
                .unwrap(),
            u64::MAX / 2
        );
        assert_eq!(
            FeeDataStrategy::Progressive(params.clone())
                .compute_fee(u64::MAX)
                .unwrap(),
            u64::MAX / 2
        );
    }

    #[test]
    fn test_amount_one_all_curves() {
        let params = FeeParams {
            max_fee: 1_000_000,
            half_amount: 1_000_000,
        };
        assert_eq!(
            FeeDataStrategy::Linear(params.clone())
                .compute_fee(1)
                .unwrap(),
            0
        );
        assert_eq!(
            FeeDataStrategy::Regressive(params.clone())
                .compute_fee(1)
                .unwrap(),
            0
        );
        assert_eq!(
            FeeDataStrategy::Progressive(params.clone())
                .compute_fee(1)
                .unwrap(),
            0
        );
    }

    #[test]
    fn test_fee_never_exceeds_max() {
        let params = FeeParams {
            max_fee: 100,
            half_amount: 50,
        };
        for amount in [0, 1, 50, 100, 500, 1000, u64::MAX] {
            let linear = FeeDataStrategy::Linear(params.clone())
                .compute_fee(amount)
                .unwrap();
            let regressive = FeeDataStrategy::Regressive(params.clone())
                .compute_fee(amount)
                .unwrap();
            let progressive = FeeDataStrategy::Progressive(params.clone())
                .compute_fee(amount)
                .unwrap();
            assert!(
                linear <= params.max_fee,
                "Linear fee {} > max_fee {} for amount {}",
                linear,
                params.max_fee,
                amount
            );
            assert!(
                regressive <= params.max_fee,
                "Regressive fee {} > max_fee {} for amount {}",
                regressive,
                params.max_fee,
                amount
            );
            assert!(
                progressive <= params.max_fee,
                "Progressive fee {} > max_fee {} for amount {}",
                progressive,
                params.max_fee,
                amount
            );
        }
    }

    #[test]
    fn test_fee_monotonically_increasing() {
        let params = FeeParams {
            max_fee: 10000,
            half_amount: 5000,
        };
        let amounts = [0, 1, 10, 100, 500, 1000, 5000, 10000, 50000, u64::MAX];
        for strategy_fn in [
            FeeDataStrategy::Linear as fn(FeeParams) -> FeeDataStrategy,
            FeeDataStrategy::Regressive,
            FeeDataStrategy::Progressive,
        ] {
            let strategy = strategy_fn(params.clone());
            let fees: Vec<u64> = amounts
                .iter()
                .map(|&a| strategy.compute_fee(a).unwrap())
                .collect();
            for i in 1..fees.len() {
                assert!(
                    fees[i] >= fees[i - 1],
                    "{:?}: fee({}) = {} < fee({}) = {}",
                    strategy,
                    amounts[i],
                    fees[i],
                    amounts[i - 1],
                    fees[i - 1]
                );
            }
        }
    }

    #[test]
    fn test_params_accessor() {
        let params = FeeParams {
            max_fee: 42,
            half_amount: 21,
        };
        let strategy = FeeDataStrategy::Regressive(params.clone());
        assert_eq!(strategy.params(), &params);
    }

    // --- Borsh round-trip tests ---

    #[test]
    fn test_borsh_roundtrip_fee_params() {
        let params = FeeParams {
            max_fee: 12345,
            half_amount: 6789,
        };
        let encoded = borsh::to_vec(&params).unwrap();
        let decoded: FeeParams = borsh::from_slice(&encoded).unwrap();
        assert_eq!(params, decoded);
    }

    #[test]
    fn test_borsh_roundtrip_strategy() {
        let strategies = vec![
            FeeDataStrategy::Linear(FeeParams {
                max_fee: 100,
                half_amount: 50,
            }),
            FeeDataStrategy::Regressive(FeeParams {
                max_fee: 200,
                half_amount: 100,
            }),
            FeeDataStrategy::Progressive(FeeParams {
                max_fee: 300,
                half_amount: 150,
            }),
        ];
        for strategy in strategies {
            let encoded = borsh::to_vec(&strategy).unwrap();
            let decoded: FeeDataStrategy = borsh::from_slice(&encoded).unwrap();
            assert_eq!(strategy, decoded);
        }
    }

    // --- Precise calculation verification ---

    #[test]
    fn test_linear_precise_calculations() {
        let strategy = FeeDataStrategy::Linear(FeeParams {
            max_fee: 10_000_000,
            half_amount: 100_000_000,
        });
        assert_eq!(strategy.compute_fee(50_000_000).unwrap(), 2_500_000);
        assert_eq!(strategy.compute_fee(200_000_000).unwrap(), 10_000_000);
        assert_eq!(strategy.compute_fee(300_000_000).unwrap(), 10_000_000);
    }

    #[test]
    fn test_regressive_precise_calculations() {
        let strategy = FeeDataStrategy::Regressive(FeeParams {
            max_fee: 10_000_000,
            half_amount: 100_000_000,
        });
        assert_eq!(strategy.compute_fee(100_000_000).unwrap(), 5_000_000);
        assert_eq!(strategy.compute_fee(200_000_000).unwrap(), 6_666_666);
    }

    #[test]
    fn test_progressive_precise_calculations() {
        let strategy = FeeDataStrategy::Progressive(FeeParams {
            max_fee: 10_000_000,
            half_amount: 100_000_000,
        });
        assert_eq!(strategy.compute_fee(100_000_000).unwrap(), 5_000_000);
        assert_eq!(strategy.compute_fee(200_000_000).unwrap(), 8_000_000);
    }

    // --- 18-decimal token tests (realistic amounts) ---

    #[test]
    fn test_realistic_sol_amounts() {
        // 9-decimal token (SOL): max_fee = 0.01 SOL, half_amount = 100 SOL
        let strategy = FeeDataStrategy::Progressive(FeeParams {
            max_fee: 10_000_000,          // 0.01 SOL
            half_amount: 100_000_000_000, // 100 SOL
        });
        // 50 SOL: fee = 10M * (50B)^2 / ((100B)^2 + (50B)^2) = 2_000_000
        assert_eq!(strategy.compute_fee(50_000_000_000).unwrap(), 2_000_000);
    }

    #[test]
    fn test_realistic_18_decimal_amounts() {
        // 18-decimal token: max_fee = 0.001 tokens (10^15), half_amount = 1 token (10^18)
        let strategy = FeeDataStrategy::Progressive(FeeParams {
            max_fee: 1_000_000_000_000_000,         // 10^15
            half_amount: 1_000_000_000_000_000_000, // 10^18
        });
        // 1 token: fee = 10^15 * (10^18)^2 / ((10^18)^2 + (10^18)^2) = 10^15 / 2
        assert_eq!(
            strategy.compute_fee(1_000_000_000_000_000_000).unwrap(),
            500_000_000_000_000
        );
    }
}
