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

#[cfg(test)]
mod tests {
    use hyperlane_core::FixedPointNumber;

    use super::GasPrice;

    #[test]
    fn to_fixed_point_number_none_returns_zero() {
        let result = GasPrice::None.to_fixed_point_number().unwrap();
        assert_eq!(result, FixedPointNumber::zero());
    }

    #[test]
    fn to_fixed_point_number_non_eip1559_uses_gas_price() {
        let gas_price = 42_000u64.into();
        let result = GasPrice::NonEip1559 { gas_price }
            .to_fixed_point_number()
            .unwrap();
        let expected: FixedPointNumber = gas_price.try_into().unwrap();
        assert_eq!(result, expected);
    }

    #[test]
    fn to_fixed_point_number_eip1559_uses_max_fee() {
        let max_fee = 77_000u64.into();
        let max_priority_fee = 1_000u64.into();
        let result = GasPrice::Eip1559 {
            max_fee,
            max_priority_fee,
        }
        .to_fixed_point_number()
        .unwrap();
        let expected: FixedPointNumber = max_fee.try_into().unwrap();
        assert_eq!(result, expected);
    }

    #[test]
    fn to_fixed_point_number_supports_large_values() {
        let result = GasPrice::NonEip1559 {
            gas_price: hyperlane_core::U256::MAX,
        }
        .to_fixed_point_number();
        assert!(result.is_ok());
    }
}
