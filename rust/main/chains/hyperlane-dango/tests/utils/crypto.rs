use {
    grug::{HashExt, HexByteArray},
    hyperlane_core::H256,
    k256::{ecdsa::SigningKey, elliptic_curve::rand_core::OsRng},
};

pub struct HexKey {
    pub key: H256,
}

impl HexKey {
    pub fn new_random() -> Self {
        let sk = SigningKey::random(&mut OsRng);
        let key = H256::from(Into::<[u8; 32]>::into(sk.to_bytes()));
        Self { key }
    }
    pub fn address(&self) -> HexByteArray<20> {
        let sk = SigningKey::from_bytes(self.key.as_ref().into()).unwrap();
        let pk = sk
            .verifying_key()
            .to_encoded_point(false)
            .as_bytes()
            .to_vec();
        let b = &pk[1..];
        let pk_hash = b.keccak256();
        let address = HexByteArray::from_inner(pk_hash[12..].try_into().unwrap());
        address
    }
}
