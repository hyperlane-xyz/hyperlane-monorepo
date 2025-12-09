use hex;
use hyperlane_core::H256;
use kaspa_addresses::{Address, Prefix, Version};
use kaspa_consensus_core::tx::ScriptPublicKey;
use kaspa_txscript::pay_to_address_script;
use std::collections::HashSet;
use std::hash::Hash;

pub fn kaspa_address_to_h256(address: Address) -> H256 {
    let bytes_32: [u8; 32] = address.payload.as_slice().try_into().unwrap();
    H256::from_slice(&bytes_32)
}

/// Convert a kaspa address string to a hex string prefixed with "0x"
/// for use as Hyperlane transfer recipient field
pub fn kaspa_address_to_hex_recipient(kaspa_addr: &str) -> String {
    let addr = Address::try_from(kaspa_addr).unwrap();
    let h256 = kaspa_address_to_h256(addr);
    format!("0x{}", hex::encode(h256.as_bytes()))
}

pub fn get_recipient_address(recipient: H256, prefix: Prefix) -> Address {
    Address::new(
        prefix,
        Version::PubKey, // should always be PubKey
        recipient.as_bytes(),
    )
}

pub fn get_recipient_script_pubkey(recipient: H256, prefix: Prefix) -> ScriptPublicKey {
    pay_to_address_script(&get_recipient_address(recipient, prefix))
}

pub fn get_recipient_script_pubkey_address(address: &Address) -> ScriptPublicKey {
    pay_to_address_script(address)
}

/// Find the first duplicate if any.
pub fn find_duplicate<T>(v: &[T]) -> Option<T>
where
    T: Eq + Hash + Clone,
{
    let mut seen = HashSet::new();
    v.iter().find(|&item| !seen.insert(item)).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use dym_kas_core::pskt::{input_sighash_type, is_valid_sighash_type};
    use std::str::FromStr;

    #[test]
    fn test_kaspa_address_to_h256() {
        let kaspa_str = "kaspatest:qq053k5up93kj5a3l08zens447s62ndstyrnuusserehq4laun7es8q29fwd4";
        let kaspa = Address::constructor(kaspa_str);
        let h256 = kaspa_address_to_h256(kaspa.clone());
        let kaspa_actual = get_recipient_address(h256, Prefix::Testnet);

        assert_eq!(kaspa, kaspa_actual)
    }

    #[test]
    fn test_input_sighash_type() {
        assert!(is_valid_sighash_type(input_sighash_type()));
    }

    #[test]
    fn test_recipient_address_roundtrip() {
        let h256 =
            H256::from_str("0xbcff7587f574e249b549329291239682d6d3481ccbc5997c79770a607ab3ec98")
                .unwrap();
        let address = get_recipient_address(h256, Prefix::Testnet);
        let script_pubkey = get_recipient_script_pubkey(h256, Prefix::Testnet);
        assert!(!script_pubkey.script().is_empty());
        assert_eq!(address.prefix, Prefix::Testnet);
    }

    #[test]
    fn test_find_duplicate() {
        let v = vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        assert_eq!(find_duplicate(&v), None);
    }
}
