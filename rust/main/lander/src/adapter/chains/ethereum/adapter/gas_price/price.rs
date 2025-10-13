use ethers_core::types::transaction::eip2718::TypedTransaction::{Eip1559, Eip2930, Legacy};

use hyperlane_core::U256;

use crate::adapter::EthereumTxPrecursor;

#[derive(Clone, Debug, PartialEq)]
pub enum GasPrice {
    None,
    NonEip1559 {
        gas_price: U256,
    },
    Eip1559 {
        max_fee: U256,
        max_priority_fee: U256,
    },
}

pub fn extract_gas_price(tx_precursor: &EthereumTxPrecursor) -> GasPrice {
    match &tx_precursor.tx {
        Legacy(r) => match r.gas_price {
            Some(gas_price) => GasPrice::NonEip1559 {
                gas_price: gas_price.into(),
            },
            None => GasPrice::None,
        },
        Eip2930(r) => match r.tx.gas_price {
            Some(gas_price) => GasPrice::NonEip1559 {
                gas_price: gas_price.into(),
            },
            None => GasPrice::None,
        },
        Eip1559(r) => match (r.max_fee_per_gas, r.max_priority_fee_per_gas) {
            (Some(max_fee), Some(max_priority_fee)) => GasPrice::Eip1559 {
                max_fee: max_fee.into(),
                max_priority_fee: max_priority_fee.into(),
            },
            _ => GasPrice::None,
        },
    }
}
