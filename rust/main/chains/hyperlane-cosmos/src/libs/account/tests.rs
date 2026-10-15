use std::str::FromStr;

use cosmrs::crypto::PublicKey;

use crypto::decompress_public_key;
use hyperlane_core::AccountAddressType;
use AccountAddressType::{Bitcoin, Ethereum};

use crate::{utils::cometbft_pubkey_to_cosmrs_pubkey, CosmosAccountId};

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
    let cometbft_key = cometbft::PublicKey::from_raw_secp256k1(&hex).unwrap();

    cometbft_pubkey_to_cosmrs_pubkey(&cometbft_key)
        .expect("Failed to deserialize cosmrs::PublicKey")
}

fn decompressed_public_key() -> PublicKey {
    let hex = hex::decode(COMPRESSED_PUBLIC_KEY).unwrap();
    let decompressed = decompress_public_key(&hex).unwrap();
    let cometbft_key = cometbft::PublicKey::from_raw_secp256k1(&decompressed).unwrap();

    cometbft_pubkey_to_cosmrs_pubkey(&cometbft_key)
        .expect("Failed to deserialize cosmrs::PublicKey")
}

#[derive(serde::Deserialize)]
struct MultisigFixture {
    public_key: MultisigKeyFixture,
    address: String,
}

#[derive(serde::Deserialize)]
struct MultisigKeyFixture {
    threshold: u32,
    public_keys: Vec<PublicKey>,
}

#[test]
fn test_celestia_multisig_accounts() {
    // Successful Celestia transactions at heights 8537428, 8539315,
    // 8544063, 8546716, 8546743. Expected addresses were independently
    // reproduced with @cosmjs/amino 0.36.0 pubkeyToAddress and matched
    // the on-chain sender (and account public key for the last transaction).
    let fixtures: Vec<MultisigFixture> =
        serde_json::from_str(include_str!("celestia_multisig.json")).expect("valid test fixture");
    for fixture in fixtures {
        let key = cosmrs::crypto::LegacyAminoMultisig {
            threshold: fixture.public_key.threshold,
            public_keys: fixture.public_key.public_keys,
        };
        let actual = CosmosAccountId::account_id_from_multisig(&key, "celestia")
            .expect("valid test fixture");
        assert_eq!(actual.as_ref(), fixture.address);
    }
}

#[test]
fn test_multisig_rejects_invalid_thresholds() {
    for (threshold, public_keys) in [
        (0, vec![compressed_public_key()]),
        (1, vec![]),
        (2, vec![compressed_public_key()]),
    ] {
        let key = cosmrs::crypto::LegacyAminoMultisig {
            threshold,
            public_keys,
        };
        assert!(CosmosAccountId::account_id_from_multisig(&key, "celestia").is_err());
    }
}

#[test]
fn test_cosmjs_two_of_three_multisig_vector() {
    // https://github.com/cosmos/cosmjs/blob/v0.36.0/packages/amino/src/addresses.spec.ts
    let keys = [
        "A4y1mO5UEw00+OCBjneHqgYTmg4tACbK22YrVc8WhZpn",
        "ApBvG9lRbIzTtSY5MiyAG/hyTB+l6HjA4yub1sC7iw9o",
        "A8yTUZ1htobabw6M/5Qx41a0X5EGPtb4H3nd2JiFiADz",
    ];
    let mut key = cosmrs::crypto::LegacyAminoMultisig {
        threshold: 2,
        public_keys: keys
            .into_iter()
            .map(|key| {
                PublicKey::from_json(&format!(
                    r#"{{"@type":"/cosmos.crypto.secp256k1.PubKey","key":"{key}"}}"#
                ))
                .expect("valid test fixture")
            })
            .collect(),
    };
    let expected = "wasm1pzf2wlat97n7rykrk7e8g8nxste6hde0r8jqsy";
    assert_eq!(
        CosmosAccountId::account_id_from_multisig(&key, "wasm")
            .expect("valid test fixture")
            .as_ref(),
        expected
    );
    key.public_keys.reverse();
    assert_ne!(
        CosmosAccountId::account_id_from_multisig(&key, "wasm")
            .expect("valid test fixture")
            .as_ref(),
        expected
    );
}

#[test]
fn test_multisig_ed25519_member() {
    let key = cosmrs::crypto::LegacyAminoMultisig {
        threshold: 1,
        public_keys: vec![PublicKey::from_json(
            r#"{"@type":"/cosmos.crypto.ed25519.PubKey","key":"Eu5vWB/lVnOh6eE4Kggp4yB1oKpHY8lovFJuGFLnjJU="}"#
        ).expect("valid test fixture")],
    };
    // Independently generated with @cosmjs/amino 0.36.0 pubkeyToAddress.
    assert_eq!(
        CosmosAccountId::account_id_from_multisig(&key, "cosmos")
            .expect("valid test fixture")
            .as_ref(),
        "cosmos1mc6djfl6af94vfgxxy04n2zayrfc87l6jeq2f7"
    );
}
