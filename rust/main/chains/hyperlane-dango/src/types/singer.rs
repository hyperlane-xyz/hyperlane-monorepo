use {
    crate::DangoResult,
    dango_client::SingleSigner,
    grug::{Addr, Defined},
    std::{ops::Deref, sync::Arc},
    tokio::sync::RwLock,
};

#[derive(Clone, Debug)]
pub struct DangoSigner {
    pub address: Addr,
    key: Arc<RwLock<SingleSigner<Defined<u32>>>>,
}

impl DangoSigner {
    pub fn new(username: &str, key: [u8; 32], address: Addr) -> DangoResult<Self> {
        let sign = SingleSigner::from_private_key(username, address, key)?;
        Ok(Self {
            address,
            key: Arc::new(RwLock::new(sign.with_nonce(0))),
        })
    }
}

impl Deref for DangoSigner {
    type Target = Arc<RwLock<SingleSigner<Defined<u32>>>>;
    fn deref(&self) -> &Self::Target {
        &self.key
    }
}
