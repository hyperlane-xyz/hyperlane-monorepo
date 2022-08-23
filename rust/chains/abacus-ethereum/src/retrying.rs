use std::{fmt::Debug, str::FromStr, time::Duration};

use async_trait::async_trait;
use ethers::providers::{Http, JsonRpcClient, ProviderError};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use thiserror::Error;
use tokio::time::sleep;
use tracing::{debug, info, instrument, trace, warn};

use crate::HttpClientError;

const METHODS_TO_NOT_RETRY: &[&str] = &[
    "eth_estimateGas",
    "eth_sendTransaction",
    "eth_sendRawTransaction",
];

/// An HTTP Provider with a simple naive exponential backoff built-in
#[derive(Debug, Clone)]
pub struct RetryingProvider<P> {
    inner: P,
    max_requests: u32,
    base_retry_ms: u64,
}

impl<P> RetryingProvider<P> {
    /// Instantiate a RetryingProvider
    pub fn new(inner: P, max_requests: Option<u32>, base_retry_ms: Option<u64>) -> Self {
        Self {
            inner,
            max_requests: max_requests.unwrap_or(6),
            base_retry_ms: base_retry_ms.unwrap_or(50),
        }
    }

    /// Set the max_requests (and by extension the total time a request can take).
    pub fn set_max_requests(&mut self, max_requests: u32) {
        assert!(max_requests >= 1);
        self.max_requests = max_requests;
    }

    /// Set what the base amount of backoff time there should be.
    pub fn set_base_retry_ms(&mut self, base_retry_ms: u64) {
        assert!(base_retry_ms >= 1);
        self.base_retry_ms = base_retry_ms;
    }

    /// Get the max_requests
    pub fn max_requests(&self) -> u32 {
        self.max_requests
    }

    /// Get the base retry duration in ms.
    pub fn base_retry_ms(&self) -> u64 {
        self.base_retry_ms
    }
}

/// Error type for the RetryingProvider
#[derive(Error, Debug)]
pub enum RetryingProviderError<P>
where
    P: JsonRpcClient,
{
    /// An internal error in the JSON RPC Client which we did not want to retry on.
    #[error(transparent)]
    JsonRpcClientError(P::Error),
    /// Hit max requests
    #[error("Hit max requests")]
    MaxRequests(P::Error),
}

impl<P> From<RetryingProviderError<P>> for ProviderError
where
    P: JsonRpcClient + 'static,
    <P as JsonRpcClient>::Error: Send + Sync,
{
    fn from(src: RetryingProviderError<P>) -> Self {
        ProviderError::JsonRpcClientError(Box::new(src))
    }
}

#[async_trait]
impl JsonRpcClient for RetryingProvider<Http> {
    type Error = RetryingProviderError<Http>;

    #[instrument(level = "error", skip_all, fields(method = %method))]
    async fn request<T, R>(&self, method: &str, params: T) -> Result<R, Self::Error>
    where
        T: Debug + Serialize + Send + Sync,
        R: DeserializeOwned,
    {
        let params = serde_json::to_value(params).expect("valid");

        let mut last_err;
        let mut i = 1;
        loop {
            let backoff_ms = self.base_retry_ms * 2u64.pow(i - 1);
            trace!(params = %serde_json::to_string(&params).unwrap_or_default(), "Dispatching request with params");
            debug!(attempt = i, "Dispatching request");

            let fut = match params {
                Value::Null => self.inner.request(method, ()),
                _ => self.inner.request(method, &params),
            };

            match fut.await {
                Ok(res) => return Ok(res),
                Err(HttpClientError::ReqwestError(e)) => {
                    info!(
                        backoff_ms,
                        retries_remaining = self.max_requests - i,
                        error = %e,
                        "ReqwestError in retrying provider.",
                    );
                    last_err = HttpClientError::ReqwestError(e);
                }
                Err(HttpClientError::JsonRpcError(e)) => {
                    // We don't want to retry errors that are probably not going to work if we keep
                    // retrying them or that indicate an error in higher-order logic and not
                    // transient provider (connection or other) errors.
                    if METHODS_TO_NOT_RETRY.contains(&method) {
                        warn!(error = %e, "JsonRpcError in retrying provider; not retrying.");
                        return Err(RetryingProviderError::JsonRpcClientError(
                            HttpClientError::JsonRpcError(e),
                        ));
                    } else {
                        info!(error = %e, "JsonRpcError in retrying provider.");
                        last_err = HttpClientError::JsonRpcError(e);
                    }
                }
                Err(HttpClientError::SerdeJson { err, text }) => {
                    info!(error = %err, "SerdeJson error in retrying provider");
                    last_err = HttpClientError::SerdeJson { err, text };
                }
            }

            i += 1;
            if i <= self.max_requests {
                trace!(backoff_ms, "Retrying provider going to sleep.");
                sleep(Duration::from_millis(backoff_ms)).await;
            } else {
                trace!(
                    requests_made = self.max_requests,
                    "Retrying provider reached max requests."
                );
                return Err(RetryingProviderError::MaxRequests(last_err));
            }
        }
    }
}

impl<P> FromStr for RetryingProvider<P>
where
    P: JsonRpcClient + FromStr,
{
    type Err = <P as FromStr>::Err;

    fn from_str(src: &str) -> Result<Self, Self::Err> {
        Ok(Self::new(src.parse()?, None, None))
    }
}
