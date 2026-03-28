use {
    crate::DangoResult,
    dango_client::{Secp256k1, Secret, SingleSigner},
    dango_types::auth::Nonce,
    grug::{Addr, Defined, QueryClient},
    std::sync::Arc,
    tokio::sync::RwLock,
};

#[derive(Clone, Debug)]
pub struct DangoSigner {
    pub address: Addr,
    key: Arc<RwLock<SingleSigner<Secp256k1, Defined<Nonce>>>>,
    user: Arc<tokio::sync::OnceCell<()>>,
}

impl DangoSigner {
    pub fn new(key: [u8; 32], address: Addr) -> DangoResult<Self> {
        let secret = Secp256k1::from_bytes(key)?;
        let sign = SingleSigner::new(address, secret).with_user_index(0);
        Ok(Self {
            address,
            key: Arc::new(RwLock::new(sign.with_nonce(0))),
            user: Arc::new(tokio::sync::OnceCell::new()),
        })
    }

    async fn try_update_user_index<C>(&self, client: &C) -> Result<(), anyhow::Error>
    where
        C: QueryClient,
        anyhow::Error: From<C::Error>,
    {
        self.user
            .get_or_try_init(|| async {
                let user_index = self.key.read().await.query_user_index(client).await;
                self.key.write().await.user_index = Defined::new(user_index?);
                Ok::<_, anyhow::Error>(())
            })
            .await?;

        Ok(())
    }

    pub async fn r#use<C>(
        &self,
        client: &C,
    ) -> Result<&Arc<RwLock<SingleSigner<Secp256k1, Defined<Nonce>>>>, anyhow::Error>
    where
        C: QueryClient,
        anyhow::Error: From<C::Error>,
    {
        self.try_update_user_index(client).await?;
        Ok(&self.key)
    }
}
