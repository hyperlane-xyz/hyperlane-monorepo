use hyperlane_core::H256;

/// Conversion from a fuel type to H256 primitive.
pub trait FuelIntoH256 {
    /// Covert to an H256 primitive.
    fn into_h256(self) -> H256;
}

macro_rules! impl_into_h256 {
    ($type:ty, $method:expr) => {
        impl FuelIntoH256 for $type {
            fn into_h256(self) -> H256 {
                let method: fn($type) -> H256 = $method;
                method(self)
            }
        }

        impl FuelIntoH256 for &$type {
            fn into_h256(self) -> H256 {
                let method: fn($type) -> H256 = $method;
                method(self.clone())
            }
        }
    };
}

impl_into_h256!(fuels::prelude::Bech32ContractId, |v| H256::from(*v.hash));
impl_into_h256!(fuels::prelude::Bits256, |v| H256::from(v.0));
