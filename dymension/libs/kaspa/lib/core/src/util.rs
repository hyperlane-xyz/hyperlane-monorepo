use hyperlane_core::H256;
use kaspa_addresses::{Address, Prefix, Version};
use kaspa_consensus_core::tx::ScriptPublicKey;
use kaspa_txscript::pay_to_address_script;

pub fn get_recipient_address(recipient: H256, prefix: Prefix) -> Address {
    Address::new(
        prefix,
        Version::PubKey, // should always be PubKey
        recipient.as_bytes(),
    )
}

pub fn get_recipient_script_pubkey(recipient: H256, prefix: Prefix) -> ScriptPublicKey {
    ScriptPublicKey::from(pay_to_address_script(&get_recipient_address(
        recipient, prefix,
    )))
}

pub fn get_recipient_script_pubkey_address(address: &Address) -> ScriptPublicKey {
    ScriptPublicKey::from(pay_to_address_script(address))
}
