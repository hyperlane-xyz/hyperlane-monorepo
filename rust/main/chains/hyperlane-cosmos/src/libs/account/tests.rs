use cosmrs::crypto::PublicKey;

use crypto::decompress_public_key;
use hyperlane_core::AccountAddressType;
use AccountAddressType::{Bitcoin, Ethereum};

use crate::CosmosAccountId;

const COMPRESSED_PUBLIC_KEY: &str =
    "02962d010010b6eec66846322704181570d89e28236796579c535d2e44d20931f4";
const INJECTIVE_ADDRESS: &str = "inj1m6ada382hfuxvuke4h9p4uswhn2qcca7mlg0dr";
const NEUTRON_ADDRESS: &str = "neutron1mydju5alsmhnfsawy0j4lyns70l7qukgdgy45w";

#[test]
fn test_account_id() {
    // given
    let pub_key = compressed_public_key();

    // when
    let neutron_account_id =
        CosmosAccountId::account_id_from_pubkey(pub_key, "neutron", &Bitcoin).unwrap();
    let injective_account_id =
        CosmosAccountId::account_id_from_pubkey(pub_key, "inj", &Ethereum).unwrap();

    // then
    assert_eq!(neutron_account_id.as_ref(), NEUTRON_ADDRESS);
    assert_eq!(injective_account_id.as_ref(), INJECTIVE_ADDRESS);
}

#[test]
fn test_bitcoin_style() {
    // given
    let compressed = compressed_public_key();
    let decompressed = decompressed_public_key();

    // when
    let from_compressed = CosmosAccountId::bitcoin_style(compressed, "neutron").unwrap();
    let from_decompressed = CosmosAccountId::bitcoin_style(decompressed, "neutron").unwrap();

    // then
    assert_eq!(from_compressed.as_ref(), NEUTRON_ADDRESS);
    assert_eq!(from_decompressed.as_ref(), NEUTRON_ADDRESS);
}

#[test]
fn test_ethereum_style() {
    // given
    let compressed = compressed_public_key();
    let decompressed = decompressed_public_key();

    // when
    let from_compressed = CosmosAccountId::ethereum_style(compressed, "inj").unwrap();
    let from_decompressed = CosmosAccountId::ethereum_style(decompressed, "inj").unwrap();

    // then
    assert_eq!(from_compressed.as_ref(), INJECTIVE_ADDRESS);
    assert_eq!(from_decompressed.as_ref(), INJECTIVE_ADDRESS);
}

fn compressed_public_key() -> PublicKey {
    let hex = hex::decode(COMPRESSED_PUBLIC_KEY).unwrap();
    let tendermint = tendermint::PublicKey::from_raw_secp256k1(&hex).unwrap();

    PublicKey::from(tendermint)
}

fn decompressed_public_key() -> PublicKey {
    let hex = hex::decode(COMPRESSED_PUBLIC_KEY).unwrap();
    let decompressed = decompress_public_key(&hex).unwrap();
    let tendermint = tendermint::PublicKey::from_raw_secp256k1(&decompressed).unwrap();

    PublicKey::from(tendermint)
}
