use hyperlane_core::U256;

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
