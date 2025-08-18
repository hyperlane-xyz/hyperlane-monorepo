use bech32::{Bech32m, Hrp};
use hyperlane_core::{ChainResult, H256, U256};
use scrypto::{
    math::{Decimal, I192},
    network::NetworkDefinition,
    types::{ComponentAddress, NodeId},
};

use crate::HyperlaneRadixError;

/// Encodes a bytes array into a bech32 radix component addresse
pub fn encode_component_address(network: &NetworkDefinition, address: H256) -> ChainResult<String> {
    encode_module_address("component", &network.hrp_suffix, address) // TODO: there has to be a constant in radix that defines this
}

/// Encodes a bytes array into a bech32 radix address
/// radix bech32 addresses always follow a certain schema: {module}_{network_prefix}_xxxxxxxxxxx
pub fn encode_module_address(module: &str, suffix: &str, address: H256) -> ChainResult<String> {
    let slice: &[u8; 32] = address.as_fixed_bytes();

    // Take only the last 30 bytes as required for Radix component addresses
    let bytes = slice[32 - NodeId::LENGTH..].to_vec();

    let hrp = format!("{}_{}", module, suffix);
    let hrp = Hrp::parse(&hrp).map_err(|e| HyperlaneRadixError::Bech32Error(format!("{}", e)))?;
    let encoded = bech32::encode::<Bech32m>(hrp, &bytes)
        .map_err(|e| HyperlaneRadixError::Bech32Error(format!("{}", e)))?;
    Ok(encoded)
}

/// Encodes a bytes array into a bech32 radix address
/// radix bech32 addresses always follow a certain schema: txid_{network_prefix}_xxxxxxxxxxx
pub fn encode_tx(network: &NetworkDefinition, address: H256) -> ChainResult<String> {
    let slice: &[u8; 32] = address.as_fixed_bytes();

    let hrp = format!("txid_{}", network.hrp_suffix);
    let hrp = Hrp::parse(&hrp).map_err(|e| HyperlaneRadixError::Bech32Error(format!("{}", e)))?;
    let encoded = bech32::encode::<Bech32m>(hrp, slice)
        .map_err(|e| HyperlaneRadixError::Bech32Error(format!("{}", e)))?;
    Ok(encoded)
}

/// decodes a bech32 encoded address into bytes
pub fn decode_bech32(bech32_address: &str) -> ChainResult<Vec<u8>> {
    let (_, value) = bech32::decode(bech32_address).map_err(HyperlaneRadixError::from)?;
    Ok(value)
}

/// converts an internal radix address to a H256
/// first two bytes are set to 0, as the radix address is 30 bytes long
pub fn address_to_h256(component_address: ComponentAddress) -> H256 {
    let mut bytes = [0u8; 32];
    let node_bytes = component_address.as_bytes();
    bytes[2..].copy_from_slice(node_bytes);
    H256::from(bytes)
}

/// converts a H256 address to a radix component address
pub fn address_from_h256(address: H256) -> ComponentAddress {
    let bytes: &[u8; 32] = address.as_fixed_bytes();

    let mut component_bytes = [0u8; NodeId::LENGTH];
    component_bytes.copy_from_slice(&bytes[2..NodeId::LENGTH + 2]);

    ComponentAddress::new_or_panic(component_bytes)
}

/// converts a radix decimal to a u256
pub fn decimal_to_u256(decimal: Decimal) -> U256 {
    let decimal: I192 = decimal.attos();
    if decimal.is_negative() {
        U256::zero()
    } else {
        U256::from_little_endian(&decimal.abs().to_le_bytes())
    }
}
