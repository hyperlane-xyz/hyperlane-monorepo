use k256::ecdsa::{SigningKey, VerifyingKey};

pub struct KeyPair {
    pub priv_key: SigningKey,
    pub pub_key: VerifyingKey,
}
