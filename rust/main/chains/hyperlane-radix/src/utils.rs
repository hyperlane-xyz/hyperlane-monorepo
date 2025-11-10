use bech32::{Bech32m, Hrp};
use scrypto::{
    math::{Decimal, I192},
    network::NetworkDefinition,
    types::{ComponentAddress, NodeId},
};

use hyperlane_core::{ChainResult, H256, U256};

use crate::HyperlaneRadixError;

/// Encodes a bytes array into a bech32 radix component address
pub fn encode_component_address(network: &NetworkDefinition, address: H256) -> ChainResult<String> {
    encode_module_address("component", &network.hrp_suffix, address) // TODO: there has to be a constant in radix that defines this
}

/// Encodes a bytes array into a bech32 radix address
/// radix bech32 addresses always follow a certain schema: {module}_{network_prefix}_xxxxxxxxxxx
pub fn encode_module_address(module: &str, suffix: &str, address: H256) -> ChainResult<String> {
    let slice: &[u8; 32] = address.as_fixed_bytes();

    // Take only the last 30 bytes as required for Radix component addresses
    let bytes = slice[32 - NodeId::LENGTH..].to_vec();

    let hrp = format!("{module}_{suffix}");
    let hrp = Hrp::parse(&hrp).map_err(|e| HyperlaneRadixError::Bech32Error(format!("{e}")))?;
    let encoded = bech32::encode::<Bech32m>(hrp, &bytes)
        .map_err(|e| HyperlaneRadixError::Bech32Error(format!("{e}")))?;
    Ok(encoded)
}

/// Encodes a bytes array into a bech32 radix address
/// radix bech32 addresses always follow a certain schema: txid_{network_prefix}_xxxxxxxxxxx
pub fn encode_tx(network: &NetworkDefinition, address: H256) -> ChainResult<String> {
    let slice: &[u8; 32] = address.as_fixed_bytes();

    let hrp = format!("txid_{}", network.hrp_suffix);
    let hrp = Hrp::parse(&hrp).map_err(|e| HyperlaneRadixError::Bech32Error(format!("{e}")))?;
    let encoded = bech32::encode::<Bech32m>(hrp, slice)
        .map_err(|e| HyperlaneRadixError::Bech32Error(format!("{e}")))?;
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

/// converts an internal radix address to a H256
/// first two bytes are set to 0, as the radix address is 30 bytes long
pub fn radix_address_bytes_to_h256(value: &[u8]) -> H256 {
    let mut bytes = [0u8; 32];
    bytes[2..].copy_from_slice(value);
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

#[cfg(test)]
mod tests {
    use super::*;
    use scrypto::constants::FAUCET;
    use scrypto::math::Decimal;
    use scrypto::network::NetworkDefinition;

    fn get_test_network() -> NetworkDefinition {
        NetworkDefinition::mainnet()
    }

    #[test]
    fn test_encode_component_address() {
        let network = get_test_network();
        let test_address = H256::from([0u8; 32]);

        let result = encode_component_address(&network, test_address);
        assert!(result.is_ok());

        let encoded = result.unwrap();
        assert_eq!(
            encoded,
            "component_rdx1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqaeq3h6"
        );
    }

    #[test]
    fn test_encode_module_address() {
        let test_address = H256::from([0u8; 32]);
        let result = encode_module_address("test", "rdx", test_address);

        assert!(result.is_ok());
        let encoded = result.unwrap();
        assert_eq!(
            encoded,
            "test_rdx1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqct33l3"
        )
    }

    #[test]
    fn test_encode_tx() {
        let network = get_test_network();
        let test_address = H256::from([0u8; 32]);

        let result = encode_tx(&network, test_address);
        assert!(result.is_ok());

        let encoded = result.unwrap();
        assert_eq!(
            encoded,
            "txid_rdx1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq7euex0"
        )
    }

    #[test]
    fn test_decode_bech32_valid() {
        // First encode something, then decode it
        let test_address = H256::from([0u8; 32]);
        let encoded = encode_module_address("test", "rdx", test_address).unwrap();

        let result = decode_bech32(&encoded);
        assert!(result.is_ok());

        let decoded = result.unwrap();
        assert_eq!(decoded.len(), 30); // Should be 30 bytes for component address

        assert!(decoded.iter().all(|x| *x == 0));
    }

    #[test]
    fn test_decode_bech32_invalid() {
        let result = decode_bech32("invalid_bech32_string");
        assert!(result.is_err());
    }

    #[test]
    fn test_address_to_h256() {
        let component_address = FAUCET;
        let h256_result = address_to_h256(component_address);

        let expected: [u8; 32] = [
            0, 0, 192, 86, 99, 24, 198, 49, 140, 100, 247, 152, 202, 204, 99, 24, 198, 49, 140,
            247, 190, 138, 247, 138, 120, 248, 166, 49, 140, 99, 24, 198,
        ];

        assert_eq!(h256_result.0, expected);
    }

    #[test]
    fn test_address_from_h256() {
        let test_h256 = H256::from([
            0, 0, 192, 86, 99, 24, 198, 49, 140, 100, 247, 152, 202, 204, 99, 24, 198, 49, 140,
            247, 190, 138, 247, 138, 120, 248, 166, 49, 140, 99, 24, 198,
        ]);

        let component_address = address_from_h256(test_h256);
        let component_bytes = component_address.as_bytes();

        assert_eq!(component_bytes, FAUCET.as_bytes())
    }

    #[test]
    fn test_decimal_to_u256_positive() {
        let decimal = Decimal::from(42);
        let result = decimal_to_u256(decimal);

        assert_eq!(result, U256::from(42000000000000000000u128)) // 42 * 1e18
    }

    #[test]
    fn test_decimal_to_u256_zero() {
        let decimal = Decimal::ZERO;
        let result = decimal_to_u256(decimal);

        assert_eq!(result, U256::zero());
    }

    #[test]
    fn test_decimal_to_u256_negative() {
        let decimal = Decimal::from(-42);
        let result = decimal_to_u256(decimal);

        // Negative decimals should return zero
        assert_eq!(result, U256::zero());
    }
}
