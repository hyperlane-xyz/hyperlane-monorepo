use dym_kas_core::escrow::EscrowPublic;
use kaspa_addresses::Prefix;
use secp256k1::PublicKey;
use std::str::FromStr;

pub fn get_escrow_address(pub_keys: Vec<&str>, required_signatures: u8, env: &str) -> String {
    let prefix = match env {
        "mainnet" => Prefix::Mainnet,
        "testnet" => Prefix::Testnet,
        _ => panic!("invalid env: {env}, must be 'testnet' or 'mainnet'"),
    };
    let pub_keys = pub_keys
        .iter()
        .enumerate()
        .map(|(i, s)| {
            PublicKey::from_str(s).unwrap_or_else(|e| {
                panic!(
                    "invalid public key at position {} (0-indexed): '{}' (len={}): {}",
                    i,
                    s,
                    s.len(),
                    e
                )
            })
        })
        .collect::<Vec<_>>();
    let e = EscrowPublic::from_pubs(pub_keys, prefix, required_signatures);
    e.addr.to_string()
}
