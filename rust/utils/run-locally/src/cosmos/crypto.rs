// TODO: this file can be removed by replacing `KeyPair` uses with `CosmosAddress`

use k256::ecdsa::{SigningKey, VerifyingKey};
use ripemd::Ripemd160;
use sha2::{Digest, Sha256};

pub fn sha256_digest(bz: impl AsRef<[u8]>) -> [u8; 32] {
    let mut hasher = Sha256::new();

    hasher.update(bz);

    hasher.finalize().as_slice().try_into().unwrap()
}

pub fn ripemd160_digest(bz: impl AsRef<[u8]>) -> [u8; 20] {
    let mut hasher = Ripemd160::new();

    hasher.update(bz);

    hasher.finalize().as_slice().try_into().unwrap()
}

pub fn pub_to_addr(pub_key: &[u8], prefix: &str) -> String {
    let sha_hash = sha256_digest(pub_key);
    let rip_hash = ripemd160_digest(sha_hash);

    let addr = hyperlane_cosmwasm_interface::types::bech32_encode(prefix, &rip_hash).unwrap();

    addr.to_string()
}

pub struct KeyPair {
    pub priv_key: SigningKey,
    pub pub_key: VerifyingKey,
}

impl KeyPair {
    pub fn pub_key_to_binary(&self) -> Vec<u8> {
        self.pub_key.to_encoded_point(true).as_bytes().to_vec()
    }

    pub fn addr(&self, hrp: &str) -> String {
        pub_to_addr(&self.pub_key_to_binary(), hrp)
    }
}
