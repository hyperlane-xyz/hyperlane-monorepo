use hyperlane_core::H256;
use kaspa_addresses::{Address, Prefix, Version};

pub fn get_recipient_address(recipient: H256, prefix: Prefix) -> Address {
    Address::new(
        prefix,
        Version::PubKey, // should always be PubKey
        recipient.as_bytes(),
    )
}
