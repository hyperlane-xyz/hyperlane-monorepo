use dymension_kaspa::kas_bridge::util::kaspa_address_to_hex_recipient;

/// Convert a kaspa addr (like kaspatest:qr0jmjgh2sx88q9gdegl449cuygp5rh6yarn5h9fh97whprvcsp2ksjkx456f)
/// to something that can be passed to Hyperlane on the hub in the transfer recipient field (like 0xdf2dc917540c7380a86e51fad4b8e1101a0efa27473a5ca9b97ceb846cc402ab)
pub fn hl_recipient(kaspa_addr: &str) -> String {
    kaspa_address_to_hex_recipient(kaspa_addr)
}

#[cfg(test)]
mod tests {
    use super::*;
    use dymension_kaspa::kas_bridge::util::get_recipient_address;
    use hyperlane_core::H256;
    use kaspa_addresses::Prefix;

    #[test]
    fn test_convert_addr_roundtrip() {
        // Use a PubKey version address (starts with 'q')
        let original = "kaspatest:qzlq49spp66vkjjex0w7z8708f6zteqwr6swy33fmy4za866ne90vhy54uh3j";
        let res = hl_recipient(original);

        let unprefixed = res.chars().skip(2).collect::<String>();
        let unhexed = hex::decode(unprefixed).unwrap();
        let decoded = H256::from_slice(&unhexed);

        let prefix = Prefix::Testnet;
        let recovered = get_recipient_address(decoded, prefix);

        assert_eq!(recovered.to_string(), original);
    }
}
