use crate::accounts::FeeData;

/// Compute the fee for a given amount based on the fee data.
/// All intermediate math uses u128 to avoid overflow.
pub fn compute_fee(fee_data: &FeeData, amount: u64) -> u64 {
    match fee_data {
        FeeData::Linear {
            max_fee,
            half_amount,
        } => {
            if *half_amount == 0 || *max_fee == 0 {
                return 0;
            }
            // fee = min(max_fee, amount * max_fee / (2 * half_amount))
            let numerator = (amount as u128) * (*max_fee as u128);
            let denominator = 2u128 * (*half_amount as u128);
            let fee = numerator / denominator;
            std::cmp::min(*max_fee, fee as u64)
        }
        FeeData::Regressive {
            max_fee,
            half_amount,
        } => {
            if *half_amount == 0 || *max_fee == 0 {
                return 0;
            }
            // fee = max_fee * amount / (half_amount + amount)
            let numerator = (*max_fee as u128) * (amount as u128);
            let denominator = (*half_amount as u128) + (amount as u128);
            (numerator / denominator) as u64
        }
        FeeData::Progressive {
            max_fee,
            half_amount,
        } => {
            if *half_amount == 0 || *max_fee == 0 {
                return 0;
            }
            // fee = max_fee * amount^2 / (half_amount^2 + amount^2)
            let amount_sq = (amount as u128) * (amount as u128);
            let half_sq = (*half_amount as u128) * (*half_amount as u128);
            let numerator = (*max_fee as u128) * amount_sq;
            let denominator = half_sq + amount_sq;
            (numerator / denominator) as u64
        }
        FeeData::Routing => {
            // Routing delegates to per-domain fee accounts; should never be called directly.
            0
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
        assert_eq!(compute_fee(&fee_data, 5000), 500);
    }

    #[test]
    fn test_linear_fee_capped() {
        let fee_data = FeeData::Linear {
            max_fee: 1000,
            half_amount: 5000,
        };
        // fee = min(1000, 20000 * 1000 / 10000) = min(1000, 2000) = 1000
        assert_eq!(compute_fee(&fee_data, 20000), 1000);
    }

    #[test]
    fn test_linear_fee_zero_amount() {
        let fee_data = FeeData::Linear {
            max_fee: 1000,
            half_amount: 5000,
        };
        assert_eq!(compute_fee(&fee_data, 0), 0);
    }

    #[test]
    fn test_linear_fee_zero_half_amount() {
        let fee_data = FeeData::Linear {
            max_fee: 1000,
            half_amount: 0,
        };
        assert_eq!(compute_fee(&fee_data, 5000), 0);
    }

    #[test]
    fn test_regressive_fee_basic() {
        let fee_data = FeeData::Regressive {
            max_fee: 1000,
            half_amount: 5000,
        };
        // fee = 1000 * 5000 / (5000 + 5000) = 500
        assert_eq!(compute_fee(&fee_data, 5000), 500);
    }

    #[test]
    fn test_regressive_fee_approaches_max() {
        let fee_data = FeeData::Regressive {
            max_fee: 1000,
            half_amount: 5000,
        };
        // fee = 1000 * 1000000 / (5000 + 1000000) = ~995
        assert_eq!(compute_fee(&fee_data, 1_000_000), 995);
    }

    #[test]
    fn test_progressive_fee_basic() {
        let fee_data = FeeData::Progressive {
            max_fee: 1000,
            half_amount: 5000,
        };
        // fee = 1000 * 5000^2 / (5000^2 + 5000^2) = 500
        assert_eq!(compute_fee(&fee_data, 5000), 500);
    }

    #[test]
    fn test_progressive_fee_small_amount() {
        let fee_data = FeeData::Progressive {
            max_fee: 1000,
            half_amount: 5000,
        };
        // fee = 1000 * 100^2 / (5000^2 + 100^2) = 1000 * 10000 / 25010000 ≈ 0
        assert_eq!(compute_fee(&fee_data, 100), 0);
    }

    #[test]
    fn test_routing_returns_zero() {
        assert_eq!(compute_fee(&FeeData::Routing, 1000), 0);
    }

    #[test]
    fn test_large_amounts_no_overflow() {
        let fee_data = FeeData::Linear {
            max_fee: u64::MAX,
            half_amount: u64::MAX,
        };
        // fee = min(MAX, MAX * MAX / (2 * MAX)) = min(MAX, MAX/2)
        assert_eq!(compute_fee(&fee_data, u64::MAX), u64::MAX / 2);
    }
}
