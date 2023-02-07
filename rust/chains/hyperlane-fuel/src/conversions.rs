use hyperlane_core::H256;

/// Conversion from a fuel type to H256 primitive.
pub trait FuelIntoH256 {
    /// Covert to an H256 primitive.
    fn into_h256(self) -> H256;
}

/// Conversion from an H256 primitive to a type to an H256 primitive
pub trait FuelFromH256 {
    /// Convert an H256 primitive to this type.
    fn from_h256(v: &H256) -> Self;
}

macro_rules! impl_h256 {
    ($type:ty, $from_method:expr, $into_method:expr) => {
        impl FuelIntoH256 for $type {
            fn into_h256(self) -> H256 {
                let method: fn($type) -> H256 = $into_method;
                method(self)
            }
        }

        impl FuelIntoH256 for &$type {
            fn into_h256(self) -> H256 {
                let method: fn($type) -> H256 = $into_method;
                method(self.clone())
            }
        }

        impl FuelFromH256 for $type {
            fn from_h256(v: &H256) -> Self {
                let method: fn(&H256) -> $type = $from_method;
                method(v)
            }
        }
    };
}

impl_h256!(
    fuels::prelude::Bech32ContractId,
    |v| fuels::prelude::Bech32ContractId::from(fuels::prelude::ContractId::new(v.0)),
    |v| H256::from(*v.hash)
);

impl_h256!(
    fuels::prelude::Bits256,
    |v| fuels::prelude::Bits256(v.0),
    |v| H256::from(v.0)
);

impl_h256!(
    fuels::prelude::ContractId,
    |v| fuels::prelude::ContractId::new(v.0),
    |v| H256::from(<[u8; 32]>::from(v))
);
