use fuels::types::{Bits256, EvmAddress};
use hyperlane_core::{ModuleType, H160, H256};

/// Wrapper around the Fuel ModuleType enum.
pub struct IsmType(pub crate::contracts::interchain_security_module::ModuleType);

/// Trait for converting an array of Bits256 to an array of H256.
pub trait FromBits256Array {
    /// Convert into an array of H256
    fn into_h256_array(self) -> [H256; 32];
}

impl FromBits256Array for Vec<Bits256> {
    fn into_h256_array(self) -> [H256; 32] {
        assert!(self.len() == 32);
        let mut h256_array: [H256; 32] = [H256::zero(); 32];
        for (i, bits256) in self.iter().enumerate() {
            h256_array[i] = H256::from(bits256.0);
        }
        h256_array
    }
}

/// Trait for convertring a vector of Fuel EvmAddresses to H256
pub trait FromEvmAddressVec {
    /// Convert the vector contents into H256
    fn into_h256_vec(self) -> Vec<H256>;
}

impl FromEvmAddressVec for Vec<EvmAddress> {
    fn into_h256_vec(self) -> Vec<H256> {
        self.into_iter()
            .map(|evm_address| evm_address.into_h256())
            .collect()
    }
}

impl From<IsmType> for ModuleType {
    fn from(value: IsmType) -> Self {
        match value.0 {
            crate::contracts::interchain_security_module::ModuleType::UNUSED => ModuleType::Unused,
            crate::contracts::interchain_security_module::ModuleType::ROUTING => {
                ModuleType::Routing
            }
            crate::contracts::interchain_security_module::ModuleType::AGGREGATION => {
                ModuleType::Aggregation
            }
            crate::contracts::interchain_security_module::ModuleType::LEGACY_MULTISIG => {
                ModuleType::MessageIdMultisig
            }
            crate::contracts::interchain_security_module::ModuleType::MERKLE_ROOT_MULTISIG => {
                ModuleType::MerkleRootMultisig
            }
            crate::contracts::interchain_security_module::ModuleType::MESSAGE_ID_MULTISIG => {
                ModuleType::MessageIdMultisig
            }
            crate::contracts::interchain_security_module::ModuleType::NULL => ModuleType::Null,
            crate::contracts::interchain_security_module::ModuleType::CCIP_READ => {
                ModuleType::CcipRead
            }
        }
    }
}

/// Conversion from a primitive to fuel EvmAddress.
pub trait FuelIntoEvmAddress {
    /// Convert to an EvmAddress.
    fn into_evm_address(self) -> EvmAddress;
}

/// Conversion from a fuel type to H256 primitive.
pub trait FuelIntoH256 {
    /// Convert to an H256 primitive.
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

impl_h256!(fuels::types::Bits256, |v| fuels::types::Bits256(v.0), |v| {
    H256(v.0)
});

impl_h256!(
    fuels::prelude::ContractId,
    |v| fuels::prelude::ContractId::new(v.0),
    |v| H256::from(<[u8; 32]>::from(v))
);

impl_h256!(
    fuels::types::Bytes32,
    |v| fuels::types::Bytes32::new(v.0),
    |v| H256::from(*v)
);

impl_h256!(
    fuels::types::EvmAddress,
    |v| fuels::types::EvmAddress::from(Bits256(v.0)),
    |v| H256(v.value().0)
);

macro_rules! impl_evm_address {
    ($type:ty, $method:expr) => {
        impl FuelIntoEvmAddress for $type {
            fn into_evm_address(self) -> EvmAddress {
                let method: fn($type) -> EvmAddress = $method;
                method(self)
            }
        }

        impl FuelIntoEvmAddress for &$type {
            fn into_evm_address(self) -> EvmAddress {
                let method: fn($type) -> EvmAddress = $method;
                method(self.clone())
            }
        }
    };
}

impl_evm_address!(H160, |v: H160| {
    let mut padded = [0u8; 32];
    padded[12..32].copy_from_slice(&v.0);
    EvmAddress::from(Bits256(padded))
});
impl_evm_address!(Bits256, |v: Bits256| EvmAddress::from(v));
