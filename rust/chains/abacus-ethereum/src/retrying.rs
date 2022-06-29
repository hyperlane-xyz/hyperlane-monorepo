use std::{fmt::Debug, str::FromStr, time::Duration};

use async_trait::async_trait;
use ethers::providers::{Http, JsonRpcClient, ProviderError};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use thiserror::Error;
use tokio::time::sleep;
use tracing::{debug, instrument, warn};

use crate::HttpClientError;

/// An HTTP Provider with a simple naive exponential backoff built-in
#[derive(Debug, Clone)]
pub struct RetryingProvider<P> {
    inner: P,
    max_requests: usize,
    base_retry_ms: u64,
}

impl<P> RetryingProvider<P> {
    /// Instantiate a RetryingProvider
    pub fn new(inner: P, max_requests: usize, base_retry_ms: u64) -> Self {
        let mut zelf = Self {
            inner,
            max_requests: 0,
            base_retry_ms: 0,
        };
        zelf.set_max_requests(max_requests);
        zelf.set_base_retry_ms(base_retry_ms);
        zelf
    }

    /// Set the max_requests (and by extension the total time a request can take).
    pub fn set_max_requests(&mut self, max_requests: usize) {
        assert!(max_requests >= 1);
        self.max_requests = max_requests;
    }

    /// Set what the base amount of backoff time there should be.
    pub fn set_base_retry_ms(&mut self, base_retry_ms: u64) {
        assert!(base_retry_ms >= 1);
        self.base_retry_ms = base_retry_ms;
    }

    /// Get the max_requests
    pub fn max_requests(&self) -> usize {
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

    #[instrument(
    level = "debug",
    err,
    skip(params),
    fields(method = %method, params = %serde_json::to_string(&params).unwrap()))
    ]
    async fn request<T, R>(&self, method: &str, params: T) -> Result<R, Self::Error>
    where
        T: Debug + Serialize + Send + Sync,
        R: DeserializeOwned,
    {
        let mut last_err = None;

        let params = serde_json::to_value(params).expect("valid");

        for i in 0..self.max_requests {
            let backoff_ms = self.base_retry_ms * 2u64.pow(i as u32);
            {
                debug!(attempt = i, "Dispatching request");

                let fut = match params {
                    Value::Null => self.inner.request(method, ()),
                    _ => self.inner.request(method, &params),
                };

                match fut.await {
                    Ok(res) => return Ok(res),
                    Err(HttpClientError::ReqwestError(e)) => {
                        warn!(
                            backoff_ms,
                            retries_remaining = self.max_requests - i - 1,
                            error = %e,
                            "ReqwestError in retrying provider; will retry after backoff.",
                        );
                        last_err = Some(HttpClientError::ReqwestError(e));
                    }
                    Err(HttpClientError::JsonRpcError(e)) => {
                        // This is a client error so we do not want to retry on it.
                        warn!(error = %e, "JsonRpcError in retrying provider; not retrying.");
                        return Err(RetryingProviderError::JsonRpcClientError(
                            HttpClientError::JsonRpcError(e),
                        ));
                    }
                    Err(HttpClientError::SerdeJson { err, text }) => {
                        warn!(error = %err, "SerdeJson error in retrying provider; not retrying.");
                        return Err(RetryingProviderError::JsonRpcClientError(
                            HttpClientError::SerdeJson { err, text },
                        ));
                    }
                }
            }
            sleep(Duration::from_millis(backoff_ms)).await;
        }

        return Err(RetryingProviderError::MaxRequests(last_err.unwrap()));
    }
}

impl<P> FromStr for RetryingProvider<P>
where
    P: JsonRpcClient + FromStr,
{
    type Err = <P as FromStr>::Err;

    fn from_str(src: &str) -> Result<Self, Self::Err> {
        Ok(Self::new(src.parse()?, 6, 50))
    }
}
