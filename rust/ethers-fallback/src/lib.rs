use async_trait::async_trait;
use ethers_providers::{JsonRpcClient, JsonRpcClientWrapper, ProviderError, WrappedParams};
use serde::{de::DeserializeOwned, Serialize};
use thiserror::Error;
use tracing::warn;

/// A provider that bundles multiple providers and attempts to call the first,
/// then the second, and so on until a response is received.
#[derive(Debug, Clone)]
pub struct FallbackProvider<T = Box<dyn JsonRpcClientWrapper>> {
    /// Sorted list of providers this provider calls in order of most primary to
    /// most fallback.
    providers: Vec<T>,
}

impl FallbackProvider<Box<dyn JsonRpcClientWrapper>> {
    /// Create a `QuorumProvider` for different `JsonRpcClient` types
    pub fn dyn_rpc() -> FallbackProviderBuilder<Box<dyn JsonRpcClientWrapper>> {
        Self::builder()
    }
}

impl<T> FallbackProvider<T> {
    /// Convenience method for creating a `FallbackProviderBuilder` with same
    /// `JsonRpcClient` types
    pub fn builder() -> FallbackProviderBuilder<T> {
        FallbackProviderBuilder::default()
    }

    pub fn new(providers: impl IntoIterator<Item = T>) -> Self {
        Self::builder().add_providers(providers).build()
    }

    pub fn providers(&self) -> &[T] {
        &self.providers
    }

    pub fn add_provider(&mut self, provider: T) {
        self.providers.push(provider);
    }
}

#[derive(Debug, Clone)]
pub struct FallbackProviderBuilder<T> {
    providers: Vec<T>,
}

impl<T> Default for FallbackProviderBuilder<T> {
    fn default() -> Self {
        Self {
            providers: Vec::new(),
        }
    }
}

impl<T> FallbackProviderBuilder<T> {
    pub fn add_provider(mut self, provider: T) -> Self {
        self.providers.push(provider);
        self
    }
    pub fn add_providers(mut self, providers: impl IntoIterator<Item = T>) -> Self {
        self.providers.extend(providers);
        self
    }

    pub fn build(self) -> FallbackProvider<T> {
        FallbackProvider {
            providers: self.providers,
        }
    }
}

/// Error thrown when sending an HTTP request
#[derive(Error, Debug)]
pub enum FallbackError {
    #[error("All providers failed. (Errors: {:?})", errors)]
    AllProvidersFailed { errors: Vec<ProviderError> },
}

impl From<FallbackError> for ProviderError {
    fn from(src: FallbackError) -> Self {
        ProviderError::JsonRpcClientError(Box::new(src))
    }
}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
impl<C> JsonRpcClient for FallbackProvider<C>
where
    C: JsonRpcClientWrapper,
{
    type Error = ProviderError;

    async fn request<T: Serialize + Send + Sync, R: DeserializeOwned>(
        &self,
        method: &str,
        params: T,
    ) -> Result<R, Self::Error> {
        let params = WrappedParams::new(params)?;

        let mut errors = vec![];
        for (idx, provider) in self.providers.iter().enumerate() {
            match provider.request(method, params.clone()).await {
                Ok(v) => return Ok(serde_json::from_value(v)?),

                // TODO: Figure out what (if any) errors we do not want fallback on.
                Err(e) => {
                    warn!(error=%e, provider_index=%idx, ?provider, method, "Provider query failed, falling back to the next provider");
                    errors.push(e)
                }
            }
        }

        Err(FallbackError::AllProvidersFailed { errors }.into())
    }
}
