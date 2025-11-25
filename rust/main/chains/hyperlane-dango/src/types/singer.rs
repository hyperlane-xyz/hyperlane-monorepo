use {
    crate::DangoResult,
    dango_client::{Secp256k1, Secret, SingleSigner},
    dango_types::auth::Nonce,
    grug::{Addr, Defined},
    std::{ops::Deref, sync::Arc},
    tokio::sync::RwLock,
};

#[derive(Clone, Debug)]
pub struct DangoSigner {
    pub address: Addr,
    key: Arc<RwLock<SingleSigner<Secp256k1, Defined<Nonce>>>>,
}

impl DangoSigner {
    pub fn new(username: &str, key: [u8; 32], address: Addr) -> DangoResult<Self> {
        let secret = Secp256k1::from_bytes(key)?;
        let sign = SingleSigner::new(username, address, secret)?;
        Ok(Self {
            address,
            key: Arc::new(RwLock::new(sign.with_nonce(0))),
        })
    }
}

impl Deref for DangoSigner {
    type Target = Arc<RwLock<SingleSigner<Secp256k1, Defined<Nonce>>>>;

    fn deref(&self) -> &Self::Target {
        &self.key
    }
}
