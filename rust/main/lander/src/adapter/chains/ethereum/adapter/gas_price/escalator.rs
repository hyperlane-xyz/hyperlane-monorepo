use ethers::types::{
    transaction::eip2718::TypedTransaction::{Eip1559, Eip2930, Legacy},
    U256,
};
use tracing::{debug, error, info, warn};

use crate::adapter::EthereumTxPrecursor;

const ESCALATION_MULTIPLIER_NUMERATOR: u32 = 110;
const ESCALATION_MULTIPLIER_DENOMINATOR: u32 = 100;

/// Sets the max between the newly estimated gas price and 1.1x the old gas price.
pub fn escalate_gas_price_if_needed(
    old_precursor: &EthereumTxPrecursor,
    newly_estimated_precursor: &mut EthereumTxPrecursor,
) {
    if old_precursor.tx.gas_price().is_none() {
        // if the old transaction precursor had no gas price set, we can skip the escalation
        info!(
            ?old_precursor,
            "No gas price set on old transaction precursor, skipping escalation"
        );
        return;
    }
    // assumes the old and new txs have the same type
    match (&old_precursor.tx, &mut newly_estimated_precursor.tx) {
        (Legacy(old), Legacy(new)) => {
            let escalated_gas_price =
                get_escalated_price_from_old_and_new(old.gas_price, new.gas_price);
            debug!(
                tx_type = "Legacy",
                old_gas_price = ?old.gas_price,
                escalated_gas_price = ?escalated_gas_price,
                "Escalation attempt outcome"
            );
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
            let escalated_gas_price =
                get_escalated_price_from_old_and_new(old.tx.gas_price, new.tx.gas_price);
            debug!(
                tx_type = "Eip2930",
                old_gas_price = ?old.tx.gas_price,
                escalated_gas_price = ?escalated_gas_price,
                "Escalation attempt outcome"
            );
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
            let escalated_max_fee_per_gas =
                get_escalated_price_from_old_and_new(old.max_fee_per_gas, new.max_fee_per_gas);

            let escalated_max_priority_fee_per_gas = get_escalated_price_from_old_and_new(
                old.max_priority_fee_per_gas,
                new.max_priority_fee_per_gas,
            );

            debug!(
                tx_type = "Eip1559",
                old_max_fee_per_gas = ?old.max_fee_per_gas,
                escalated_max_fee_per_gas = ?escalated_max_fee_per_gas,
                old_max_priority_fee_per_gas = ?old.max_priority_fee_per_gas,
                escalated_max_priority_fee_per_gas = ?escalated_max_priority_fee_per_gas,
                "Escalation attempt outcome"
            );
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
        (old, new) => {
            error!(?old, ?new, "Newly estimated transaction type does not match the old transaction type. Not escalating gas price.");
        }
    }
}

fn get_escalated_price_from_old_and_new(
    old_gas_price: Option<U256>,
    new_gas_price: Option<U256>,
) -> U256 {
    let old_gas_price = old_gas_price.unwrap_or_default();
    let escalated_gas_price = apply_escalation_multiplier(old_gas_price);
    let new_gas_price = new_gas_price.unwrap_or_default();

    escalated_gas_price.max(new_gas_price)
}

fn apply_escalation_multiplier(gas_price: U256) -> U256 {
    let numerator = U256::from(ESCALATION_MULTIPLIER_NUMERATOR);
    let denominator = U256::from(ESCALATION_MULTIPLIER_DENOMINATOR);
    gas_price * numerator / denominator
}
