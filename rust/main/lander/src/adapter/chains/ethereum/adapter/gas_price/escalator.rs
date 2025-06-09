use ethers::types::{
    transaction::eip2718::TypedTransaction::{Eip1559, Eip2930, Legacy},
    U256,
};
use tracing::{error, warn};

use crate::adapter::EthereumTxPrecursor;

const ESCALATION_MULTIPLIER_NUMERATOR: u32 = 110;
const ESCALATION_MULTIPLIER_DENOMINATOR: u32 = 100;

/// Sets the max between the newly estimated gas price and 1.1x the old gas price.
pub fn escalate_gas_price_if_needed(
    old_tx: &EthereumTxPrecursor,
    newly_estimated_tx: &mut EthereumTxPrecursor,
) {
    // assumes the old and new txs have the same type
    match (&old_tx.tx, &mut newly_estimated_tx.tx) {
        (Legacy(old), Legacy(new)) => {
            let old_gas_price = old.gas_price.unwrap_or_default();
            let escalated_gas_price = apply_escalation_multiplier(old_gas_price);
            let new_gas_price = new.gas_price.unwrap_or_default();

            let escalated_gas_price = escalated_gas_price.max(new_gas_price);
            if escalated_gas_price.is_zero() {
                warn!(
                    tx_type = "Legacy",
                    "Both old and new gas prices are set to zero. Has estimation failed?"
                );
                return;
            }
            new.gas_price = Some(escalated_gas_price);
        }
        (Eip2930(old), Eip2930(new)) => {
            let old_gas_price = old.tx.gas_price.unwrap_or_default();
            let escalated_gas_price = apply_escalation_multiplier(old_gas_price);
            let new_gas_price = new.tx.gas_price.unwrap_or_default();

            let escalated_gas_price = escalated_gas_price.max(new_gas_price);
            if escalated_gas_price.is_zero() {
                warn!(
                    tx_type = "Eip2930",
                    "Both old and new gas prices are set to zero. Has estimation failed?"
                );
                return;
            }
            new.tx.gas_price = Some(escalated_gas_price);
        }
        (Eip1559(old), Eip1559(new)) => {
            let old_max_fee_per_gas = old.max_fee_per_gas.unwrap_or_default();
            let escalated_max_fee_per_gas = apply_escalation_multiplier(old_max_fee_per_gas);
            let new_max_fee_per_gas = new.max_fee_per_gas.unwrap_or_default();
            let escalated_max_fee_per_gas = escalated_max_fee_per_gas.max(new_max_fee_per_gas);

            let old_max_priority_fee_per_gas = old.max_priority_fee_per_gas.unwrap_or_default();
            let escalated_max_priority_fee_per_gas =
                apply_escalation_multiplier(old_max_priority_fee_per_gas);
            let new_max_priority_fee_per_gas = new.max_priority_fee_per_gas.unwrap_or_default();
            let escalated_max_priority_fee_per_gas =
                escalated_max_priority_fee_per_gas.max(new_max_priority_fee_per_gas);

            if escalated_max_fee_per_gas.is_zero() && escalated_max_priority_fee_per_gas.is_zero() {
                warn!(
                    tx_type = "Eip1559",
                    "Both old and new gas prices are zero. Not escalating."
                );
                return;
            }
            new.max_fee_per_gas = Some(escalated_max_fee_per_gas);
            new.max_priority_fee_per_gas = Some(escalated_max_priority_fee_per_gas);
        }
        _ => {
            error!("Newly estimated transaction type does not match the old transaction type. Not escalating gas price.");
        }
    }
}

fn apply_escalation_multiplier(gas_price: U256) -> U256 {
    let numerator = U256::from(ESCALATION_MULTIPLIER_NUMERATOR);
    let denominator = U256::from(ESCALATION_MULTIPLIER_DENOMINATOR);
    gas_price * numerator / denominator
}
