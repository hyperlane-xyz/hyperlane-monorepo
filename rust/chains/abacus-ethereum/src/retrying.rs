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
}

impl<P> RetryingProvider<P> {
    /// Instantiate a RetryingProvider
    pub fn new(inner: P, max_requests: usize) -> Self {
        assert!(max_requests >= 1);
        Self {
            inner,
            max_requests,
        }
    }

    /// Set the max_requests (and by extension the total time a request can take)
    pub fn set_max_requests(&mut self, max_requests: usize) {
        assert!(max_requests >= 1);
        self.max_requests = max_requests;
    }

    /// Get the max_requests
    pub fn get_max_requests(&self) -> usize {
        self.max_requests
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
    fields(params = % serde_json::to_string(& params).unwrap()))
    ]
    async fn request<T, R>(&self, method: &str, params: T) -> Result<R, Self::Error>
    where
        T: Debug + Serialize + Send + Sync,
        R: DeserializeOwned,
    {
        let mut last_err = None;

        let params = serde_json::to_value(params).expect("valid");

        for i in 0..self.max_requests {
            let backoff_ms = 100;
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
                            method = %method,
                            "ReqwestError in retrying provider",
                        );
                        last_err = Some(HttpClientError::ReqwestError(e));
                    }
                    Err(HttpClientError::JsonRpcError(e)) => {
                        // This is a client error so we do not want to retry on it.
                        warn!(
                            backoff_ms,
                            retries_remaining = self.max_requests - i - 1,
                            error = %e,
                            method = %method,
                            "JsonRpcError",
                        );
                        return Err(RetryingProviderError::JsonRpcClientError(
                            HttpClientError::JsonRpcError(e),
                        ));
                    }
                    Err(HttpClientError::SerdeJson { err, text }) => {
                        warn!(
                            backoff_ms,
                            retries_remaining = self.max_requests - i - 1,
                            error = %err,

                            method = %method,
                            "SerdeJson error in retrying provider",
                        );
                        last_err = Some(HttpClientError::SerdeJson { err, text })
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
        Ok(Self::new(src.parse()?, 6))
    }
}
