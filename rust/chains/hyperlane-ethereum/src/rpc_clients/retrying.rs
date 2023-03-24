use std::{fmt::Debug, str::FromStr, time::Duration};

use crate::rpc_clients::{categorize_client_response, CategorizedResponse};
use async_trait::async_trait;
use ethers::prelude::HttpClientError;
use ethers::providers::{Http, JsonRpcClient, ProviderError};
use ethers_prometheus::json_rpc_client::PrometheusJsonRpcClient;
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use thiserror::Error;
use tokio::time::sleep;
use tracing::{debug, error, info_span, instrument, trace};

/// An HTTP Provider with a simple naive exponential backoff built-in
#[derive(Debug, Clone)]
pub struct RetryingProvider<P> {
    max_requests: u32,
    base_retry_ms: u64,
    inner: P,
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

    /// Set the max_requests (and by extension the total time a request can
    /// take).
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

/// How to handle the result from the underlying provider
enum HandleMethod<R, PE> {
    Accept(R),
    Halt(PE),
    Retry(PE),
}

impl<P> RetryingProvider<P>
where
    P: JsonRpcClient,
{
    /// The retrying provider logic which accepts a matcher function that can
    /// handle specific cases for different underlying provider
    /// implementations.
    #[instrument(skip_all, fields(method = %method))]
    async fn request_with_retry<T, R>(
        &self,
        method: &str,
        params: T,
        matcher: impl Fn(
            // result from the provider request
            Result<R, P::Error>,
            // which attempt this is
            u32,
            // what the next backoff will be in ms
            u64,
        ) -> HandleMethod<R, P::Error>,
    ) -> Result<R, RetryingProviderError<P>>
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

            match matcher(fut.await, i, backoff_ms) {
                HandleMethod::Accept(v) => {
                    return Ok(v);
                }
                HandleMethod::Halt(e) => {
                    return Err(RetryingProviderError::JsonRpcClientError(e));
                }
                HandleMethod::Retry(e) => {
                    last_err = e;
                }
            }

            i += 1;
            if i <= self.max_requests {
                trace!(backoff_ms, "Retrying provider going to sleep");
                sleep(Duration::from_millis(backoff_ms)).await;
            } else {
                trace!(
                    requests_made = self.max_requests,
                    "Retrying provider reached max requests"
                );
                return Err(RetryingProviderError::MaxRequests(last_err));
            }
        }
    }
}

/// Error type for the RetryingProvider
#[derive(Error, Debug)]
pub enum RetryingProviderError<P>
where
    P: JsonRpcClient,
{
    /// An internal error in the JSON RPC Client which we did not want to retry
    /// on.
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

const METHODS_TO_NOT_RETRY: &[&str] = &[
    "eth_sendTransaction",
    "eth_sendRawTransaction",
    "eth_feeHistory",
];

const METHODS_TO_NOT_RETRY_ON_REVERT: &[&str] = &["eth_call", "eth_estimateGas"];

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
impl JsonRpcClient for RetryingProvider<PrometheusJsonRpcClient<Http>> {
    type Error = RetryingProviderError<PrometheusJsonRpcClient<Http>>;

    #[instrument(skip(self), fields(provider_host = %self.inner.node_host(), chain_name = %self.inner.chain_name()))]
    async fn request<T, R>(&self, method: &str, params: T) -> Result<R, Self::Error>
    where
        T: Debug + Serialize + Send + Sync,
        R: DeserializeOwned,
    {
        use CategorizedResponse::*;
        use HandleMethod::*;

        self.request_with_retry::<T, R>(method, params, |res, attempt, next_backoff_ms| {
            let _span = info_span!("request_with_retry", next_backoff_ms, retries_remaining = self.max_requests - attempt).entered();

            match categorize_client_response(method, res) {
                IsOk(res) => Accept(res),
                RetryableErr(e) => Retry(e),
                NonRetryableErr(e) => Halt(e),
            }
        }).await
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
