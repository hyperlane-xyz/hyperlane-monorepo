use corelib::escrow::EscrowPublic;
use corelib::escrow::{generate_escrow_priv_key, Escrow};
use corelib::KaspaSecpKeypair;
use kaspa_addresses::Prefix;
use serde::{Deserialize, Serialize};
use validator::signer::get_ethereum_style_signer;

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
    multisig_escrow_addr: String,
}

impl ValidatorInfos {
    pub fn to_string(&self) -> String {
        serde_json::to_string_pretty(self).unwrap()
    }
}

/// Get everything needed to launch 1x validator, using a 1-1 escrow multisig
pub fn create_one_new_validator() -> ValidatorInfos {
    let kp = generate_escrow_priv_key();
    let s = serde_json::to_string(&kp).unwrap();

    let signer = get_ethereum_style_signer().unwrap();

    let pub_key = kp.public_key();
    let e = EscrowPublic::from_pubs(vec![pub_key], Prefix::Testnet, 1);

    ValidatorInfos {
        validator_ism_addr: signer.address,
        validator_ism_priv_key: signer.private_key,
        validator_escrow_secret: s,
        validator_escrow_pub_key: pub_key.to_string(),
        multisig_escrow_addr: e.addr.to_string(),
    }
}
