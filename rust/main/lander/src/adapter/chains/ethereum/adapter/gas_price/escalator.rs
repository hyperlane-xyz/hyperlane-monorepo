use ethers::types::transaction::eip2718::TypedTransaction;

use crate::adapter::EthereumTxPrecursor;

/// Sets the max between the newly estimated gas price and 1.1x the old gas price.
fn escalate_gas_price_if_needed(
    old_tx: EthereumTxPrecursor,
    newly_estimated_tx: &mut EthereumTxPrecursor,
) {
    // assumes the old and new txs have the same type
    match old_tx.tx {
        TypedTransaction::Legacy(tx) => {
            let Some(gas_price) = tx.gas_price else {
                return None;
            };
            let new_gas_price = escalator.get_gas_price(gas_price, time_elapsed);
            let mut updated_tx = tx.clone();
            updated_tx.gas_price = Some(new_gas_price);
            Some(updated_tx.into())
        }
        TypedTransaction::Eip2930(tx) => {
            let Some(gas_price) = tx.tx.gas_price else {
                return None;
            };
            let new_gas_price = escalator.get_gas_price(gas_price, time_elapsed);
            let mut updated_tx = tx.clone();
            updated_tx.tx.gas_price = Some(new_gas_price);
            Some(updated_tx.into())
        }
        TypedTransaction::Eip1559(tx) => {
            let Some(max_fee_per_gas) = tx.max_fee_per_gas else {
                return None;
            };
            let Some(max_priority_fee_per_gas) = tx.max_priority_fee_per_gas else {
                return None;
            };
            let new_max_fee_per_gas = escalator.get_gas_price(max_fee_per_gas, time_elapsed);
            let new_max_priority_fee_per_gas =
                escalator.get_gas_price(max_priority_fee_per_gas, time_elapsed);
            let mut updated_tx = tx.clone();
            updated_tx.max_fee_per_gas = Some(new_max_fee_per_gas);
            updated_tx.max_priority_fee_per_gas = Some(new_max_priority_fee_per_gas);
            Some(updated_tx.into())
        }
    }
}
