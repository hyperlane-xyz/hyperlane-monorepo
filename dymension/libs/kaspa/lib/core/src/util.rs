use hyperlane_core::H256;
use kaspa_addresses::{Address, Prefix, Version};
use kaspa_consensus_core::hashing::sighash_type::{
    SigHashType, SIG_HASH_ALL, SIG_HASH_ANY_ONE_CAN_PAY,
};
use kaspa_consensus_core::tx::ScriptPublicKey;
use kaspa_txscript::pay_to_address_script;
use std::collections::HashSet;
use std::hash::Hash;
use std::str::FromStr;
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

pub fn input_sighash_type() -> SigHashType {
    SigHashType::from_u8(SIG_HASH_ALL.to_u8() | SIG_HASH_ANY_ONE_CAN_PAY.to_u8()).unwrap()
}

pub fn is_valid_sighash_type(t: SigHashType) -> bool {
    t.to_u8() == input_sighash_type().to_u8()
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

    #[test]
    fn test_input_sighash_type() {
        assert!(is_valid_sighash_type(input_sighash_type()));
    }

    #[test]
    fn test_foo() {
        let h256 =
            H256::from_str("0xbcff7587f574e249b549329291239682d6d3481ccbc5997c79770a607ab3ec98")
                .unwrap();
        let address = get_recipient_address(h256, Prefix::Testnet);
        println!("address: {:?}", address);
        let script_pubkey = get_recipient_script_pubkey(h256, Prefix::Testnet);
        println!("script_pubkey: {:?}", script_pubkey);
    }
}
