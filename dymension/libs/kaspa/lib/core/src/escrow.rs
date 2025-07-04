use kaspa_addresses::{Address, Prefix};
use kaspa_consensus_core::tx::ScriptPublicKey;

use kaspa_txscript::{
    extract_script_pub_key_address, multisig_redeem_script, pay_to_script_hash_script,
};

use eyre::Result;
use kaspa_rpc_core::RpcScriptPublicKey;
use secp256k1::{rand::thread_rng, Keypair, PublicKey};
use serde::{Deserialize, Serialize};
use std::str::FromStr;

pub fn generate_escrow_priv_key() -> Keypair {
    Keypair::new(secp256k1::SECP256K1, &mut thread_rng())
}

pub struct Escrow {
    pub keys: Vec<Keypair>, // private
    required_signatures: u8,
}

pub struct EscrowPublic {
    pub pubs: Vec<PublicKey>,
    required_signatures: u8,
    pub redeem_script: Vec<u8>,
    pub p2sh: ScriptPublicKey,
    pub addr: Address,
}

impl Escrow {
    pub fn new(n: u8) -> Self {
        let kps = (0..n)
            .map(|_| Keypair::new(secp256k1::SECP256K1, &mut thread_rng()))
            .collect::<Vec<_>>();

        Self {
            keys: kps,
            required_signatures: n,
        }
    }

    pub fn n(&self) -> usize {
        self.keys.len()
    }

    pub fn m(&self) -> usize {
        self.required_signatures as usize
    }

    pub fn public(&self, address_prefix: Prefix) -> EscrowPublic {
        let pubs = self.keys.iter().map(|kp| kp.public_key()).collect();
        EscrowPublic::from_pubs(pubs, address_prefix, self.m() as u8)
    }
}

impl EscrowPublic {
    pub fn n(&self) -> usize {
        self.pubs.len()
    }

    pub fn m(&self) -> usize {
        self.required_signatures as usize
    }

    pub fn from_strs(pubs: Vec<String>, prefix: Prefix, required_signatures: u8) -> Self {
        let pubs = pubs
            .iter()
            .map(|pk| PublicKey::from_str(pk.as_str()).unwrap())
            .collect::<Vec<_>>();
        Self::from_pubs(pubs, prefix, required_signatures)
    }

    pub fn from_pubs(pubs: Vec<PublicKey>, prefix: Prefix, required_signatures: u8) -> Self {
        let redeem_script = multisig_redeem_script(
            pubs.iter().map(|pk| pk.x_only_public_key().0.serialize()),
            required_signatures as usize,
        )
        .unwrap();

        let p2sh = pay_to_script_hash_script(&redeem_script);
        let addr = extract_script_pub_key_address(&p2sh, prefix).unwrap();

        EscrowPublic {
            required_signatures: required_signatures,
            redeem_script,
            p2sh,
            addr,
            pubs: pubs,
        }
    }

    pub fn has_pub(&self, pub_key: &PublicKey) -> bool {
        self.pubs.contains(pub_key)
    }
}

pub fn is_utxo_escrow_address(pk: &RpcScriptPublicKey, escrow_address: &str) -> Result<bool> {
    let address = extract_script_pub_key_address(pk, Prefix::Testnet)?;
    if address.to_string() == escrow_address {
        return Ok(true);
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_escrow_priv_key() {
        let kp = generate_escrow_priv_key();
        let s = serde_json::to_string(&kp).unwrap();
        let kp_parsed: Keypair = serde_json::from_str(&s).unwrap();
        assert_eq!(kp, kp_parsed);
    }
}
