use kaspa_addresses::{Address, Prefix};
use kaspa_consensus_core::tx::ScriptPublicKey;
use kaspa_txscript::{
    extract_script_pub_key_address, multisig_redeem_script, pay_to_script_hash_script,
};
use secp256k1::{rand::thread_rng, Keypair, PublicKey};
use std::str::FromStr;

pub fn generate_escrow_priv_key() -> Keypair {
    Keypair::new(secp256k1::SECP256K1, &mut thread_rng())
}

pub struct Escrow {
    pub keys: Vec<Keypair>, // private
    required_signatures: u8,
}

#[derive(Clone, Debug)]
pub struct EscrowPublic {
    pub pubs: Vec<PublicKey>,
    required_signatures: u8,
    pub redeem_script: Vec<u8>,
    pub p2sh: ScriptPublicKey,
    pub addr: Address,
}

impl Escrow {
    pub fn new(m: u8, n: u8) -> Self {
        let kps = (0..n)
            .map(|_| Keypair::new(secp256k1::SECP256K1, &mut thread_rng()))
            .collect::<Vec<_>>();

        Self {
            keys: kps,
            required_signatures: m,
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
            required_signatures,
            redeem_script,
            p2sh,
            addr,
            pubs,
        }
    }

    pub fn has_pub(&self, pub_key: &PublicKey) -> bool {
        self.pubs.contains(pub_key)
    }
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

    #[test]
    fn test_from_pubs() {
        let pubs = "035461e2ab2584bc80435c2a3f51c4cf12285992b5e4fdec57f1f8b506134a9087,0218a9fcc6059c1995c70b8f31b2256ac3d4aeca5dffa331fb941a8c5d4bffdd76,03d7a78be7d152498cfb9fb8a89b60723f011435303499e0de7c1bcbf88f87d1b9,02f02a8dc60f124b34e9a8800fb25cf25ac01a3bdcf5a6ea21d2e2569a173dd9b2,028586f127129710cdac6ca1d86be1869bd8a8746db9a2339fde71278dff7fb469,0214d0d6d828c2f3e5ce908978622c5677c1fc53372346a9cff60d1140c54b5e5e,029035bddc82d62454b2d425e205533363d09dc5d9c0d0f74c1f937c2d211c15a1,03e4b95346367e49178c8571e8a649584981d8bd6f920c648e37bbe24f055baf9c";
        let m = 6;
        let epub = EscrowPublic::from_strs(
            pubs.split(",").map(|s| s.to_string()).collect(),
            Prefix::Testnet,
            m,
        );
        println!("escrow: {:?}", epub);
    }
}
