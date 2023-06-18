use crate::middleware::errors::ClientMiddlewareError;
use async_trait::async_trait;
use ethers::prelude::{BlockId, Bytes, Filter, Log, Middleware, PendingTransaction};
use ethers::types::transaction::eip2718::TypedTransaction;
use std::fmt::{Debug, Formatter};
use std::sync::Arc;

pub struct ClientMiddleware<M> {
    inner: Arc<M>,
}

impl<M> ClientMiddleware<M> {
    pub fn new(inner: M) -> Self {
        Self {
            inner: Arc::new(inner),
        }
    }
}

impl<M: Middleware> Debug for ClientMiddleware<M> {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(f, "ClientMiddleware({:?})", self.inner)
    }
}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
impl<M: Middleware> Middleware for ClientMiddleware<M> {
    type Error = ClientMiddlewareError<M::Error>;
    type Provider = M::Provider;
    type Inner = M;

    fn inner(&self) -> &Self::Inner {
        &self.inner
    }

    async fn send_transaction<T: Into<TypedTransaction> + Send + Sync>(
        &self,
        tx: T,
        block: Option<BlockId>,
    ) -> Result<PendingTransaction<'_, Self::Provider>, Self::Error> {
        let tx: TypedTransaction = tx.into();
        let result = self.inner.send_transaction(tx, block).await;
        Ok(result?)
    }

    async fn call(
        &self,
        tx: &TypedTransaction,
        block: Option<BlockId>,
    ) -> Result<Bytes, Self::Error> {
        let result = self.inner.call(tx, block).await;
        Ok(result?)
    }

    async fn get_logs(&self, filter: &Filter) -> Result<Vec<Log>, Self::Error> {
        let result = self.inner.get_logs(filter).await;
        Ok(result?)
    }
}
