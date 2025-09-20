use {
    async_trait::async_trait,
    grug::BlockClient,
    hyperlane_core::{rpc_clients::BlockNumberGetter, ChainResult},
    std::ops::Deref,
};

/// We need to define a wrapper around grug::ClientWrapper because we need to implement
/// BlockNumberGetter in order to use FallbackProvider for DangoProvider.
#[derive(Clone)]
pub struct ClientWrapper {
    inner: grug::ClientWrapper<anyhow::Error>,
}

impl std::fmt::Debug for ClientWrapper {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "ClientWrapper")
    }
}

impl ClientWrapper {
    pub fn new(inner: grug::ClientWrapper<anyhow::Error>) -> Self {
        Self { inner }
    }
}

#[async_trait]
impl BlockNumberGetter for ClientWrapper {
    async fn get_block_number(&self) -> ChainResult<u64> {
        Ok(self
            .query_block(None)
            .await
            .map(|block| block.info.height)?)
    }
}

impl Deref for ClientWrapper {
    type Target = grug::ClientWrapper<anyhow::Error>;

    fn deref(&self) -> &Self::Target {
        &self.inner
    }
}
