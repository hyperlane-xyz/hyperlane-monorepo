use hyperlane_core::{ChainResult, FixedPointNumber, U256};

#[derive(Clone, Debug, PartialEq, Eq)]
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

impl GasPrice {
    /// Convert GasPrice to FixedPointNumber for use in TxCostEstimate
    /// For EIP-1559 transactions, uses max_fee_per_gas
    /// For legacy transactions, uses gas_price
    pub fn to_fixed_point_number(&self) -> ChainResult<FixedPointNumber> {
        match self {
            GasPrice::None => {
                // Return zero if no gas price is set
                Ok(FixedPointNumber::default())
            }
            GasPrice::NonEip1559 { gas_price } => (*gas_price).try_into(),
            GasPrice::Eip1559 { max_fee, .. } => (*max_fee).try_into(),
        }
    }
}
