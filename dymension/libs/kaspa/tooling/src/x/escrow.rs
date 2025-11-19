use corelib::escrow::EscrowPublic;
use kaspa_addresses::Prefix;
use secp256k1::PublicKey;
use std::str::FromStr;

pub fn get_escrow_address(pub_keys: Vec<&str>, required_signatures: u8) -> String {
    let pub_keys = pub_keys
        .iter()
        .map(|s| PublicKey::from_str(s).unwrap())
        .collect::<Vec<_>>();
    let e = EscrowPublic::from_pubs(pub_keys, Prefix::Testnet, required_signatures);
    e.addr.to_string()
}
