use {
    hyperlane_core::H256,
    k256::{ecdsa::SigningKey, elliptic_curve::rand_core::OsRng},
};

pub struct ValidatorKey {
    pub key: H256,
}

impl ValidatorKey {
    pub fn new_random() -> Self {
        let sk = SigningKey::random(&mut OsRng);
        let key = H256::from(Into::<[u8; 32]>::into(sk.to_bytes()));
        Self { key }
    }
}
