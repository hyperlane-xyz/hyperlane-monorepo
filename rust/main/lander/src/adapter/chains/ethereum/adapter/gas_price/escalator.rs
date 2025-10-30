use ethers::types::transaction::eip2718::TypedTransaction::{Eip1559, Eip2930, Legacy};
use ethers_core::types::transaction::eip2718::TypedTransaction;
use tracing::{debug, error, info, warn};

use hyperlane_core::U256;
use hyperlane_ethereum::TransactionOverrides;

use crate::adapter::EthereumTxPrecursor;

use super::super::super::gas_price::GasPrice;

const ESCALATION_MULTIPLIER_NUMERATOR: u32 = 110;
const ESCALATION_MULTIPLIER_DENOMINATOR: u32 = 100;
const GAS_PRICE_CAP_MULTIPLIER: u32 = 3;

/// Escalates gas price using a 4-step process:
/// 1. Escalate old price by 10% to help stuck transactions
/// 2. Use max of escalated and newly estimated price (market responsiveness)
/// 3. Cap at gas_price_cap_multiplier × new_estimated_price (prevent runaway costs)
/// 4. Ensure result ≥ old price (RBF compatibility)
///
/// Formula: Max(Min(Max(Escalate(oldGasPrice), newEstimatedGasPrice), cap_multiplier × newEstimatedGasPrice), oldGasPrice)
pub fn escalate_gas_price_if_needed(
    old_gas_price: &GasPrice,
    estimated_gas_price: &GasPrice,
    transaction_overrides: &TransactionOverrides,
) -> GasPrice {
    // assumes the old and new txs have the same type
    match (old_gas_price, estimated_gas_price) {
        (GasPrice::None, _) => {
            // If the old gas price is None, we do not escalate.
            info!(
                ?old_gas_price,
                ?estimated_gas_price,
                "No gas price set on old transaction precursor, skipping escalation"
            );
            GasPrice::None
        }
        (_, GasPrice::None) => {
            // If the estimated gas price is None, we do not escalate.
            info!(
                ?old_gas_price,
                ?estimated_gas_price,
                "Estimated gas price is None, skipping escalation"
            );
            GasPrice::None
        }
        (
            GasPrice::NonEip1559 {
                gas_price: old_gas_price,
            },
            GasPrice::NonEip1559 {
                gas_price: estimated_gas_price,
            },
        ) => {
            let escalated_gas_price = get_escalated_price_from_old_and_new(
                old_gas_price,
                estimated_gas_price,
                transaction_overrides,
            );
            debug!(
                tx_type = "Legacy or Eip2930",
                ?old_gas_price,
                ?estimated_gas_price,
                ?escalated_gas_price,
                "Escalation attempt outcome"
            );

            GasPrice::NonEip1559 {
                gas_price: escalated_gas_price,
            }
        }
        (
            GasPrice::Eip1559 {
                max_fee: old_max_fee,
                max_priority_fee: old_max_priority_fee,
            },
            GasPrice::Eip1559 {
                max_fee: estimated_max_fee,
                max_priority_fee: estimated_max_priority_fee,
            },
        ) => {
            let escalated_max_fee_per_gas = get_escalated_price_from_old_and_new(
                old_max_fee,
                estimated_max_fee,
                transaction_overrides,
            );

            let escalated_max_priority_fee_per_gas = get_escalated_price_from_old_and_new(
                old_max_priority_fee,
                estimated_max_priority_fee,
                transaction_overrides,
            );

            debug!(
                tx_type = "Eip1559",
                old_max_fee_per_gas = ?old_max_fee,
                estimated_max_fee = ?estimated_max_fee,
                escalated_max_fee_per_gas = ?escalated_max_fee_per_gas,
                old_max_priority_fee_per_gas = ?old_max_priority_fee,
                estimated_max_priority_fee = ?estimated_max_priority_fee,
                escalated_max_priority_fee_per_gas = ?escalated_max_priority_fee_per_gas,
                "Escalation attempt outcome"
            );

            GasPrice::Eip1559 {
                max_fee: escalated_max_fee_per_gas,
                max_priority_fee: escalated_max_priority_fee_per_gas,
            }
        }
        (old, new) => {
            error!(?old, ?new, "Newly estimated transaction type does not match the old transaction type. Not escalating gas price.");
            GasPrice::None
        }
    }
}

fn get_escalated_price_from_old_and_new(
    old_gas_price: &U256,
    new_gas_price: &U256,
    transaction_overrides: &TransactionOverrides,
) -> U256 {
    // Step 1: Calculate escalated price (old price * 1.1)
    // This provides a 10% increase to help stuck transactions get through
    let escalated_price = apply_escalation_multiplier(old_gas_price);

    // Step 2: Take max of escalated and newly estimated price
    // This ensures we use current market conditions if they're higher than our escalation
    let competitive_price = escalated_price.max(*new_gas_price);

    // Step 3: Apply cap to prevent indefinite escalation
    // Cap = new_estimated_price * multiplier (default 3x)
    // This prevents runaway costs when network estimates drop significantly
    let multiplier = transaction_overrides
        .gas_price_cap_multiplier
        .unwrap_or_else(|| U256::from(GAS_PRICE_CAP_MULTIPLIER));
    let escalation_cap = new_gas_price.saturating_mul(multiplier);
    let capped_price = competitive_price.min(escalation_cap);

    // Step 4: Ensure price never goes backwards (RBF compatibility)
    // Replace-by-Fee requires each replacement to have higher fees than the previous
    // This prevents transaction rejections when cap is lower than old price
    capped_price.max(*old_gas_price)
}

fn apply_escalation_multiplier(gas_price: &U256) -> U256 {
    let numerator = U256::from(ESCALATION_MULTIPLIER_NUMERATOR);
    let denominator = U256::from(ESCALATION_MULTIPLIER_DENOMINATOR);
    gas_price.saturating_mul(numerator).div_mod(denominator).0
}

#[cfg(test)]
mod tests {
    use hyperlane_core::U256;

    use hyperlane_ethereum::TransactionOverrides;

    use super::*;

    fn default_transaction_overrides() -> TransactionOverrides {
        TransactionOverrides {
            gas_price_cap_multiplier: Some(U256::from(3)),
            ..Default::default()
        }
    }

    #[test]
    fn test_gas_price_does_not_overflow() {
        let old_gas_price = GasPrice::Eip1559 {
            max_fee: U256::MAX,
            max_priority_fee: U256::MAX,
        };
        let estimated_gas_price = GasPrice::Eip1559 {
            max_fee: U256::MAX,
            max_priority_fee: U256::MAX,
        };

        // should not overflow and panic
        let res = escalate_gas_price_if_needed(
            &old_gas_price,
            &estimated_gas_price,
            &default_transaction_overrides(),
        );
        let expected = GasPrice::Eip1559 {
            max_fee: U256::MAX,
            max_priority_fee: U256::MAX,
        };

        assert_eq!(res, expected);
    }

    #[test]
    fn test_gas_price_cap_applied_for_legacy_tx() {
        // Test that escalated price is capped by 3x the new estimated price
        let old_gas_price = GasPrice::NonEip1559 {
            gas_price: U256::from(1000), // High old price
        };
        let estimated_gas_price = GasPrice::NonEip1559 {
            gas_price: U256::from(100), // Low new estimated price
        };

        let res = escalate_gas_price_if_needed(
            &old_gas_price,
            &estimated_gas_price,
            &default_transaction_overrides(),
        );

        // Escalated would be 1000 * 1.1 = 1100
        // Cap is 100 * 3 = 300
        // Capped would be min(max(1100, 100), 300) = 300
        // But final result must be max(300, 1000) = 1000 (can't go backwards)
        let expected = GasPrice::NonEip1559 {
            gas_price: U256::from(1000), // Can't go below old price
        };

        assert_eq!(res, expected);
    }

    #[test]
    fn test_gas_price_cap_applied_for_eip1559_tx() {
        // Test that escalated price is capped by 3x the new estimated price for EIP-1559
        let old_gas_price = GasPrice::Eip1559 {
            max_fee: U256::from(2000),
            max_priority_fee: U256::from(1000),
        };
        let estimated_gas_price = GasPrice::Eip1559 {
            max_fee: U256::from(200),
            max_priority_fee: U256::from(100),
        };

        let res = escalate_gas_price_if_needed(
            &old_gas_price,
            &estimated_gas_price,
            &default_transaction_overrides(),
        );

        // Escalated max_fee would be 2000 * 1.1 = 2200
        // Cap for max_fee is 200 * 3 = 600
        // Capped would be min(max(2200, 200), 600) = 600
        // But final max_fee must be max(600, 2000) = 2000 (can't go backwards)

        // Escalated max_priority_fee would be 1000 * 1.1 = 1100
        // Cap for max_priority_fee is 100 * 3 = 300
        // Capped would be min(max(1100, 100), 300) = 300
        // But final max_priority_fee must be max(300, 1000) = 1000 (can't go backwards)
        let expected = GasPrice::Eip1559 {
            max_fee: U256::from(2000),          // Can't go below old price
            max_priority_fee: U256::from(1000), // Can't go below old price
        };

        assert_eq!(res, expected);
    }

    #[test]
    fn test_gas_price_cap_not_applied_when_escalated_lower_than_cap() {
        // Test that cap is not applied when escalated price is already lower
        let old_gas_price = GasPrice::NonEip1559 {
            gas_price: U256::from(100),
        };
        let estimated_gas_price = GasPrice::NonEip1559 {
            gas_price: U256::from(200), // Higher new estimated price
        };

        let res = escalate_gas_price_if_needed(
            &old_gas_price,
            &estimated_gas_price,
            &default_transaction_overrides(),
        );

        // Escalated would be 100 * 1.1 = 110
        // Cap is 200 * 3 = 600
        // Result should be min(max(110, 200), 600) = 200 (new estimated price is higher)
        let expected = GasPrice::NonEip1559 {
            gas_price: U256::from(200),
        };

        assert_eq!(res, expected);
    }

    #[test]
    fn test_gas_price_escalation_without_cap() {
        // Test normal escalation when cap doesn't apply
        let old_gas_price = GasPrice::NonEip1559 {
            gas_price: U256::from(100),
        };
        let estimated_gas_price = GasPrice::NonEip1559 {
            gas_price: U256::from(50), // Lower new estimated price
        };

        let res = escalate_gas_price_if_needed(
            &old_gas_price,
            &estimated_gas_price,
            &default_transaction_overrides(),
        );

        // Escalated would be 100 * 1.1 = 110
        // Cap is 50 * 3 = 150
        // Result should be min(max(110, 50), 150) = 110 (escalated price)
        let expected = GasPrice::NonEip1559 {
            gas_price: U256::from(110),
        };

        assert_eq!(res, expected);
    }

    #[test]
    fn test_configurable_gas_price_cap_multiplier() {
        // Test that custom gas price cap multiplier is used
        let old_gas_price = GasPrice::NonEip1559 {
            gas_price: U256::from(1000), // High old price
        };
        let estimated_gas_price = GasPrice::NonEip1559 {
            gas_price: U256::from(100), // Low new estimated price
        };

        // Use custom multiplier of 5 instead of default 3
        let custom_overrides = TransactionOverrides {
            gas_price_cap_multiplier: Some(U256::from(5)),
            ..Default::default()
        };

        let res =
            escalate_gas_price_if_needed(&old_gas_price, &estimated_gas_price, &custom_overrides);

        // Escalated would be 1000 * 1.1 = 1100
        // Cap with multiplier 5 is 100 * 5 = 500
        // Capped would be min(max(1100, 100), 500) = 500
        // But final result must be max(500, 1000) = 1000 (can't go backwards)
        let expected = GasPrice::NonEip1559 {
            gas_price: U256::from(1000), // Can't go below old price
        };

        assert_eq!(res, expected);
    }

    #[test]
    fn test_default_gas_price_cap_multiplier_when_none() {
        // Test that default multiplier (3) is used when not specified
        let old_gas_price = GasPrice::NonEip1559 {
            gas_price: U256::from(1000), // High old price
        };
        let estimated_gas_price = GasPrice::NonEip1559 {
            gas_price: U256::from(100), // Low new estimated price
        };

        // Use overrides with no gas_price_cap_multiplier set
        let default_overrides = TransactionOverrides {
            gas_price_cap_multiplier: None,
            ..Default::default()
        };

        let res =
            escalate_gas_price_if_needed(&old_gas_price, &estimated_gas_price, &default_overrides);

        // Escalated would be 1000 * 1.1 = 1100
        // Cap with default multiplier 3 is 100 * 3 = 300
        // Capped would be min(max(1100, 100), 300) = 300
        // But final result must be max(300, 1000) = 1000 (can't go backwards)
        let expected = GasPrice::NonEip1559 {
            gas_price: U256::from(1000), // Can't go below old price
        };

        assert_eq!(res, expected);
    }

    #[test]
    fn test_rbf_protection_prevents_backwards_price() {
        // Test that RBF protection prevents gas price from going backwards
        let old_gas_price = GasPrice::NonEip1559 {
            gas_price: U256::from(1000), // High old price
        };
        let estimated_gas_price = GasPrice::NonEip1559 {
            gas_price: U256::from(10), // Very low new estimated price
        };

        let res = escalate_gas_price_if_needed(
            &old_gas_price,
            &estimated_gas_price,
            &default_transaction_overrides(),
        );

        // Escalated would be 1000 * 1.1 = 1100
        // Cap is 10 * 3 = 30
        // Capped would be min(max(1100, 10), 30) = 30
        // RBF protection ensures final result is max(30, 1000) = 1000
        let expected = GasPrice::NonEip1559 {
            gas_price: U256::from(1000), // Maintains old price due to RBF protection
        };

        assert_eq!(res, expected);
    }

    #[test]
    fn test_zero_estimated_price_protection() {
        // Test protection against zero estimated prices
        let old_gas_price = GasPrice::NonEip1559 {
            gas_price: U256::from(100),
        };
        let estimated_gas_price = GasPrice::NonEip1559 {
            gas_price: U256::from(0), // Zero price
        };

        let res = escalate_gas_price_if_needed(
            &old_gas_price,
            &estimated_gas_price,
            &default_transaction_overrides(),
        );

        // Escalated would be 100 * 1.1 = 110
        // Cap is 0 * 3 = 0
        // Capped would be min(max(110, 0), 0) = 0
        // RBF protection ensures final result is max(0, 100) = 100
        let expected = GasPrice::NonEip1559 {
            gas_price: U256::from(100), // Maintains old price, prevents zeroing
        };

        assert_eq!(res, expected);
    }
}
