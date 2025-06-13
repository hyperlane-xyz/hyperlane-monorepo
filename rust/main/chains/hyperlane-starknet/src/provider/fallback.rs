use std::{ops::Deref, time::Duration};

/// Fallback HttpTransport
/// the HttpTransport abstraction is the lowest level of abstraction on the starknet json provider
/// sadly we can't implement a fallback behavior earlier, because the trait bounds do not allow for Cloning/Clopying parameters
/// This file is mostly copied from starknet::providers::jsonrpc::HttpTransport
/// https://github.com/xJonathanLEI/starknet-rs/blob/master/starknet-providers/src/jsonrpc/transports/http.rs
use async_trait::async_trait;
use hyperlane_core::{
    rpc_clients::{BlockNumberGetter, FallbackProvider},
    ChainCommunicationError, ChainResult,
};
use reqwest::Url;
use serde::{de::DeserializeOwned, Serialize};

use starknet::providers::{
    jsonrpc::{
        HttpTransport, HttpTransportError, JsonRpcMethod, JsonRpcResponse, JsonRpcTransport,
    },
    JsonRpcClient, Provider, ProviderRequestData,
};
use tokio::time::sleep;
use tracing::{trace, warn_span};

use crate::HyperlaneStarknetError;

/// Wrapped HttpTransport
#[derive(Debug, Clone)]
pub struct WrappedHttpTrasport(HttpTransport);

impl Deref for WrappedHttpTrasport {
    type Target = HttpTransport;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl WrappedHttpTrasport {
    fn new(url: Url) -> WrappedHttpTrasport {
        Self(HttpTransport::new(url))
    }
}

/// A [`JsonRpcTransport`] implementation that uses HTTP connections.
#[derive(Debug, Clone)]
pub struct FallbackHttpTransport {
    fallback: FallbackProvider<WrappedHttpTrasport, WrappedHttpTrasport>,
}

impl Deref for FallbackHttpTransport {
    type Target = FallbackProvider<WrappedHttpTrasport, WrappedHttpTrasport>;

    fn deref(&self) -> &Self::Target {
        &self.fallback
    }
}

/// Errors using [`HttpTransport`].
#[derive(Debug, thiserror::Error)]
pub enum FallbackHttpTransportError {
    /// Fallback error.
    #[error("Fallback errors: {0:?}")]
    Errors(Vec<HttpTransportError>),
    /// Chain Communication
    #[error(transparent)]
    ChainCommunication(#[from] ChainCommunicationError),
    /// JSON serialization/deserialization errors.
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

impl FallbackHttpTransport {
    /// Constructs [`FallbackHttpTransport`] from a JSON-RPC server URL, using default HTTP client settings.
    pub fn new(urls: impl IntoIterator<Item = Url>) -> Self {
        let providers = urls.into_iter().map(WrappedHttpTrasport::new);
        Self {
            fallback: FallbackProvider::new(providers),
        }
    }
}

#[async_trait]
impl BlockNumberGetter for WrappedHttpTrasport {
    /// Latest block number getter
    async fn get_block_number(&self) -> ChainResult<u64> {
        let json_rpc = JsonRpcClient::new(self.0.clone());
        json_rpc
            .block_number()
            .await
            .map_err(HyperlaneStarknetError::from)
            .map_err(ChainCommunicationError::from)
    }
}

#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
impl JsonRpcTransport for FallbackHttpTransport {
    type Error = FallbackHttpTransportError;

    async fn send_request<P, R>(
        &self,
        method: JsonRpcMethod,
        params: P,
    ) -> Result<JsonRpcResponse<R>, Self::Error>
    where
        P: Serialize + Send,
        R: DeserializeOwned,
    {
        let params_json = serde_json::to_value(params).map_err(Self::Error::Json)?;
        let mut errors = vec![];

        // Try up to 4 times
        for _ in 0..4 {
            if !errors.is_empty() {
                sleep(Duration::from_millis(100)).await;
            }

            let priorities_snapshot = self.take_priorities_snapshot().await;

            for (idx, priority) in priorities_snapshot.iter().enumerate() {
                // Create log span
                let span = warn_span!("fallback_request", fallback_count = %idx, provider_index = %priority.index);
                let _enter = span.enter();
                let provider = &self.inner.providers[priority.index];

                // first handle the stalled providers to not span the result of `send_request` in this future
                // we have to do this, because the result does not implement the `Send` trait
                let _ = self.handle_stalled_provider(priority, provider).await;

                let result = provider.send_request(method, params_json.clone()).await;

                match result {
                    Ok(resp) => return Ok(resp),
                    Err(e) => {
                        trace!(
                            error=?e,
                            "Got error from inner fallback provider",
                        );
                        errors.push(e);
                        // Continue to the next provider
                        continue;
                    }
                }
            }
        }

        // If we get here, all providers failed
        Err(FallbackHttpTransportError::Errors(errors))
    }

    async fn send_requests<R>(
        &self,
        requests: R,
    ) -> Result<Vec<JsonRpcResponse<serde_json::Value>>, Self::Error>
    where
        R: AsRef<[ProviderRequestData]> + Send + Sync,
    {
        self.call(|provider| {
            let requests = requests.as_ref().to_vec();
            let future = async move {
                let result = provider
                    .send_requests(requests)
                    .await
                    .map_err(HyperlaneStarknetError::from)
                    .map_err(ChainCommunicationError::from)?;
                Ok(result)
            };
            Box::pin(future)
        })
        .await
        .map_err(Self::Error::from)
    }
}
