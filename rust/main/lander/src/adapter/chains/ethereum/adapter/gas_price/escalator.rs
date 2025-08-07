use ethers::types::transaction::eip2718::TypedTransaction::{Eip1559, Eip2930, Legacy};
use ethers_core::types::transaction::eip2718::TypedTransaction;
use tracing::{debug, error, info, warn};

use hyperlane_core::U256;

use crate::adapter::EthereumTxPrecursor;

use super::price::GasPrice;

const ESCALATION_MULTIPLIER_NUMERATOR: u32 = 110;
const ESCALATION_MULTIPLIER_DENOMINATOR: u32 = 100;

/// Sets the max between the newly estimated gas price and 1.1x the old gas price.
pub fn escalate_gas_price_if_needed(
    old_gas_price: &GasPrice,
    estimated_gas_price: &GasPrice,
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
            let escalated_gas_price =
                get_escalated_price_from_old_and_new(old_gas_price, estimated_gas_price);
            debug!(
                tx_type = "Legacy or Eip2930",
                ?old_gas_price,
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
                max_fee: new_max_fee,
                max_priority_fee: new_max_priority_fee,
            },
        ) => {
            let escalated_max_fee_per_gas =
                get_escalated_price_from_old_and_new(old_max_fee, new_max_fee);

            let escalated_max_priority_fee_per_gas =
                get_escalated_price_from_old_and_new(old_max_priority_fee, new_max_priority_fee);

            debug!(
                tx_type = "Eip1559",
                old_max_fee_per_gas = ?old_max_fee,
                escalated_max_fee_per_gas = ?escalated_max_fee_per_gas,
                old_max_priority_fee_per_gas = ?old_max_priority_fee,
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

fn get_escalated_price_from_old_and_new(old_gas_price: &U256, new_gas_price: &U256) -> U256 {
    let escalated_gas_price = apply_escalation_multiplier(old_gas_price);
    escalated_gas_price.max(*new_gas_price)
}

fn apply_escalation_multiplier(gas_price: &U256) -> U256 {
    let numerator = U256::from(ESCALATION_MULTIPLIER_NUMERATOR);
    let denominator = U256::from(ESCALATION_MULTIPLIER_DENOMINATOR);
    gas_price.saturating_mul(numerator).div_mod(denominator).0
}

#[cfg(test)]
mod tests {
    use hyperlane_core::U256;

    use crate::adapter::chains::ethereum::adapter::gas_price::GasPrice;

    use super::*;

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
        let res = escalate_gas_price_if_needed(&old_gas_price, &estimated_gas_price);
        let expected = GasPrice::Eip1559 {
            max_fee: U256::MAX,
            max_priority_fee: U256::MAX,
        };

        assert_eq!(res, expected);
    }
}
