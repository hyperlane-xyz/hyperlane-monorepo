use kaspa_addresses::{Address, Prefix};
use kaspa_consensus_core::tx::ScriptPublicKey;

use kaspa_txscript::{
    extract_script_pub_key_address, multisig_redeem_script, pay_to_script_hash_script,
};

use secp256k1::{rand::thread_rng, Keypair, PublicKey};

pub struct Escrow {
    pub keys: Vec<Keypair>,
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
        let redeem_script = multisig_redeem_script(
            self.keys
                .iter()
                .map(|pk| pk.x_only_public_key().0.serialize()),
            self.m(),
        )
        .unwrap();

        let p2sh = pay_to_script_hash_script(&redeem_script);
        let addr = extract_script_pub_key_address(&p2sh, address_prefix).unwrap();

        EscrowPublic {
            required_signatures: self.required_signatures,
            redeem_script,
            p2sh,
            addr,
            pubs: self.keys.iter().map(|kp| kp.public_key()).collect(),
        }
    }
}

impl EscrowPublic {
    pub fn n(&self) -> usize {
        self.pubs.len()
    }

    pub fn m(&self) -> usize {
        self.required_signatures as usize
    }
}
