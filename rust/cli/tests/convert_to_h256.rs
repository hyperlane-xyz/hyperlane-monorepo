use cli::convert;
use hyperlane_core::{H160, H256};
use hyperlane_hex as hex;

const ADDRESS_HEX_STR: &str = "0165878A594ca255338adfa4d48449f69242Eb8F";
const ADDRESS_BYTES: &[u8; 40] = b"0165878A594ca255338adfa4d48449f69242Eb8F";
const ADDRESS_H256_STR: &str = "0x0000000000000000000000000165878a594ca255338adfa4d48449f69242eb8f";

#[test]
fn bytes_to_h256() {
    let address_bytes = ADDRESS_BYTES;
    let address: H256 = hex::parse_h256_raw(&address_bytes).unwrap().into();
    assert_eq!(format!("{address:?}"), ADDRESS_H256_STR);
}

#[test]
fn str_to_h256() {
    let address_bytes: &[u8; 40] = ADDRESS_HEX_STR.as_bytes().try_into().unwrap();
    let address: H256 = hex::parse_h256_raw(&address_bytes).unwrap().into();
    assert_eq!(format!("{address:?}"), ADDRESS_H256_STR);
}

#[test]
fn str_to_h160() {
    let address_bytes: &[u8; 40] = ADDRESS_HEX_STR.as_bytes().try_into().unwrap();
    let address: H256 = hex::parse_h256_raw(&address_bytes).unwrap().into();

    let address: H160 = address.into();
    assert_eq!(
        format!("{address:?}").to_lowercase(),
        format!("0x{ADDRESS_HEX_STR}").to_lowercase()
    );

    let address: H256 = address.into();
    assert_eq!(format!("{address:?}"), ADDRESS_H256_STR);
}

#[test]
fn test_try_into_h160_from_hex_str() {
    for hex in [ADDRESS_HEX_STR, &format!("0x{ADDRESS_HEX_STR}")] {
        let h160 = convert::try_into_h160_from_hex_str(hex).unwrap();
        assert_eq!(
            format!("{h160:?}").to_lowercase(),
            format!("0x{ADDRESS_HEX_STR}").to_lowercase()
        );
    }
}

#[test]
fn check_address_size() {
    assert_eq!(ADDRESS_HEX_STR.len(), 40);
}
