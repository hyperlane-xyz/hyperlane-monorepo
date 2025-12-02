use hyperlane_core::H256;
use radix_transactions::manifest::{
    ast::{Instruction, Value},
    lexer, parser,
};
use scrypto::{address::AddressBech32Decoder, network::NetworkDefinition};

use crate::radix_address_bytes_to_h256;

pub fn find_fee_payer_from_manifest(s: &str, network: &NetworkDefinition) -> Option<H256> {
    let address_bech32_decoder = AddressBech32Decoder::new(network);

    let tokens = match lexer::tokenize(s) {
        Ok(tokens) => tokens,
        Err(err) => {
            tracing::error!(?err, "Failed to tokenize manifest");
            return None;
        }
    };
    let mut instructions = match parser::Parser::new(tokens, parser::PARSER_MAX_DEPTH) {
        Ok(inst) => inst,
        Err(err) => {
            tracing::error!(?err, "Failed to parse manifest tokens");
            return None;
        }
    };

    while !instructions.is_eof() {
        let instruction = match instructions.parse_instruction() {
            Ok(inst) => inst,
            Err(err) => {
                tracing::warn!(?err, "Failed to parse instruction");
                continue;
            }
        };
        let Instruction::CallMethod {
            address,
            method_name,
            ..
        } = instruction.instruction
        else {
            continue;
        };

        // deconstruct method_name
        let Value::String(method_name) = method_name.value else {
            continue;
        };

        // https://docs.radixdlt.com/docs/account
        // could be any of:
        // - lock_fee
        // - lock_fee_and_withdraw
        // - lock_fee_and_withdraw_non_fungibles
        // - lock_fee_from_faucet
        if !method_name.starts_with("lock_fee") {
            continue;
        }

        // deconstruct address
        let Value::Address(boxed_value) = address.value else {
            continue;
        };
        let Value::String(address) = boxed_value.value else {
            continue;
        };

        let (_, address_bytes) = match address_bech32_decoder.validate_and_decode(&address) {
            Ok(v) => v,
            Err(err) => {
                tracing::error!(?err, "Failed to decode address");
                continue;
            }
        };

        // For some reason, radix addresses are 30 bytes instead of 32.
        let address_h256 = radix_address_bytes_to_h256(&address_bytes);
        return Some(address_h256);
    }
    None
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use crate::encode_module_address;

    use super::*;

    const TEST_MANIFEST: &str = include_str!("./manifest.rtm");
    const TEST_MANIFEST_WITH_WITHDRAW: &str = include_str!("./manifest_with_withdraw.rtm");
    const TEST_MANIFEST_WITH_BLOB: &str = include_str!("./manifest_with_blob.rtm");

    #[tracing_test::traced_test]
    #[test]
    fn test_decode_manifest_lock_fee() {
        let network = NetworkDefinition::mainnet();
        let fee_payer =
            find_fee_payer_from_manifest(TEST_MANIFEST, &network).expect("Fee payer not found");

        let expected_address =
            H256::from_str("0000d1e63a35dbffeb651a9d0e50ea36e30e64989bb8f5af2ba240222a06b645")
                .unwrap();
        assert_eq!(fee_payer, expected_address);

        let radix_address = encode_module_address("account", &network.hrp_suffix, expected_address)
            .expect("Failed to encode radix address");
        assert_eq!(
            radix_address,
            "account_rdx168nr5dwmll4k2x5apegw5dhrpejf3xac7khjhgjqyg4qddj9tg9v4d"
        );
    }

    #[test]
    fn test_decode_manifest_lock_fee_and_withdraw() {
        let network = NetworkDefinition::mainnet();
        let fee_payer = find_fee_payer_from_manifest(TEST_MANIFEST_WITH_WITHDRAW, &network)
            .expect("Fee payer not found");

        let expected_address =
            H256::from_str("0000d1b89f2f20e8594408303255f511b434f07a94e7037d6a64418ba1105d42")
                .unwrap();
        assert_eq!(fee_payer, expected_address);

        let radix_address = encode_module_address("account", &network.hrp_suffix, expected_address)
            .expect("Failed to encode radix address");
        assert_eq!(
            radix_address,
            "account_rdx16xuf7teqapv5gzpsxf2l2yd5xnc84988qd7k5ezp3ws3qh2z4c6rp4"
        );
    }

    #[test]
    fn test_decode_manifest_lock_fee_with_blob() {
        let network = NetworkDefinition::stokenet();
        let fee_payer = find_fee_payer_from_manifest(TEST_MANIFEST_WITH_BLOB, &network)
            .expect("Fee payer not found");

        let expected_address =
            H256::from_str("00005150bb88ca1f9e3693e8a00c1b1bdf0efa0e8179368d8eaba5c266010513")
                .unwrap();
        assert_eq!(fee_payer, expected_address);

        let radix_address = encode_module_address("account", &network.hrp_suffix, expected_address)
            .expect("Failed to encode radix address");
        assert_eq!(
            radix_address,
            "account_tdx_2_129gthzx2r70rdylg5qxpkx7lpmaqaqtex6xca2a9cfnqzpgn5av5z8"
        );
    }
}
