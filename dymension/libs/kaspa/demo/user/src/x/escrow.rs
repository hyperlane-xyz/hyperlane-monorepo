use corelib::escrow::EscrowPublic;
use corelib::escrow::{generate_escrow_priv_key, Escrow};
use corelib::KaspaSecpKeypair;
use kaspa_addresses::Prefix;
use secp256k1::PublicKey;
use serde::{Deserialize, Serialize};
use std::str::FromStr;
use validator::signer::get_ethereum_style_signer;

pub fn get_escrow_address(pub_keys: Vec<&str>) -> String {
    let pub_keys = pub_keys
        .iter()
        .map(|s| PublicKey::from_str(s).unwrap())
        .collect::<Vec<_>>();
    let e = EscrowPublic::from_pubs(pub_keys, Prefix::Testnet, 1);
    e.addr.to_string()
}

#[derive(Debug, Serialize)]
pub struct ValidatorInfos {
    // HL style address to register on the Hub for the Kaspa multisig ISM
    validator_ism_addr: String,
    /// what validator will use to sign checkpoints for new deposits (and also progress indications)
    validator_ism_priv_key: String,
    /// secret key to sign kaspa inputs for withdrawals
    validator_escrow_secret: String,
    /// and pub key...
    validator_escrow_pub_key: String,
    /// the address the bridge end user should deposit to
    multisig_escrow_addr: Option<String>,
}

impl ValidatorInfos {
    pub fn to_string(&self) -> String {
        serde_json::to_string_pretty(self).unwrap()
    }
}

pub fn create_validator() -> (ValidatorInfos, PublicKey) {
    let kp = generate_escrow_priv_key();
    let s = serde_json::to_string(&kp).unwrap();

    let signer = get_ethereum_style_signer().unwrap();
    let pub_key = kp.public_key();

    (
        ValidatorInfos {
            validator_ism_addr: signer.address,
            validator_ism_priv_key: signer.private_key,
            validator_escrow_secret: s,
            validator_escrow_pub_key: pub_key.to_string(),
            multisig_escrow_addr: None,
        },
        pub_key,
    )
}

pub fn create_validator_with_escrow() -> ValidatorInfos {
    let (mut v, pub_key) = create_validator();

    let e = EscrowPublic::from_pubs(vec![pub_key], Prefix::Testnet, 1);

    v.multisig_escrow_addr = Some(e.addr.to_string());
    v
}
