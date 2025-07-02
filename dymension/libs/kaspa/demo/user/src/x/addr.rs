use kaspa_addresses::Address;

/// Convert a kaspa addr (like kaspatest:qr0jmjgh2sx88q9gdegl449cuygp5rh6yarn5h9fh97whprvcsp2ksjkx456f)
/// to something that can be passed to Hyperlane on the hub in the transfer recipient field (like 0xdf2dc917540c7380a86e51fad4b8e1101a0efa27473a5ca9b97ceb846cc402ab)
pub fn hl_recipient(kaspa_addr: &str) -> String {
    let addr = Address::try_from(kaspa_addr).unwrap();
    let bz = addr.payload.as_slice();
    let bz_hex = hex::encode(bz);
    let s = format!("0x{}", bz_hex);
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyperlane_core::H256;
    use kaspa_addresses::Prefix;
    use relayer::withdraw_construction::get_recipient_address;

    #[test]
    fn test_convert_addr_roundtrip() {
        let original = "kaspatest:pzlq49spp66vkjjex0w7z8708f6zteqwr6swy33fmy4za866ne90v7e6pyrfr";
        let res = hl_recipient(original);

        let unprefixed = res.chars().skip(2).collect::<String>();
        let unhexed = hex::decode(unprefixed).unwrap();
        let decoded = H256::from_slice(&unhexed);

        let prefix = Prefix::Testnet;
        let recovered = get_recipient_address(decoded, prefix);
        if recovered.to_string() != original {
            println!("{}", "something wrong");
        }

        assert_eq!(res, original);
    }
}
