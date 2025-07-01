use core::escrow::EscrowPublic;
use core::escrow::{generate_escrow_priv_key, Escrow};
use core::KaspaSecpKeypair;
use kaspa_addresses::Prefix;
use serde::{Deserialize, Serialize};
use validator::signer::get_ethereum_style_signer;

#[derive(Debug, Serialize)]
pub struct Validator {
    validator_ism_addr: String,
    validator_ism_priv_key: String,
    validator_escrow_secret: String,
    validator_escrow_pub_key: String,
    multisig_escrow_addr: String,
}

impl Validator {
    pub fn to_string(&self) -> String {
        serde_json::to_string_pretty(self).unwrap()
    }
}

pub fn create_new_validator() -> Validator {
    let kp = generate_escrow_priv_key();
    let s = serde_json::to_string(&kp).unwrap();

    let signer = get_ethereum_style_signer().unwrap();

    let pub_key = kp.public_key();
    let e = EscrowPublic::from_pubs(vec![pub_key], Prefix::Testnet, 1);

    Validator {
        validator_ism_addr: signer.address,
        validator_ism_priv_key: signer.private_key,
        validator_escrow_secret: s,
        validator_escrow_pub_key: pub_key.to_string(),
        multisig_escrow_addr: e.addr.to_string(),
    }
}
