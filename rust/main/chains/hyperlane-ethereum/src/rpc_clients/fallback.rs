#[cfg(test)]
mod mock;
#[cfg(test)]
mod tests;

use std::fmt::{Debug, Formatter};
use std::future::Future;
use std::ops::Deref;
use std::pin::Pin;
use std::time::Duration;

use async_trait::async_trait;
use ethers::providers::{HttpClientError, JsonRpcClient, ProviderError};
use futures_util::{stream::FuturesUnordered, StreamExt};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use thiserror::Error;
use tokio::time::{sleep, timeout, Instant, Sleep};
use tracing::{instrument, warn};

use ethers_prometheus::json_rpc_client::JsonRpcBlockGetter;
use hyperlane_core::rpc_clients::{BlockNumberGetter, FallbackProvider, PrioritizedProviderInner};
use hyperlane_metric::prometheus_metric::{PrometheusClientMetrics, PrometheusConfigExt};

use crate::config::FallbackHedgeConfig;
use crate::rpc_clients::{categorize_client_response, CategorizedResponse};

const METHOD_SEND_RAW_TRANSACTION: &str = "eth_sendRawTransaction";
const METHOD_GET_TRANSACTION_RECEIPT: &str = "eth_getTransactionReceipt";
const METHOD_CHAIN_ID: &str = "eth_chainId";
const METHOD_GET_BALANCE: &str = "eth_getBalance";
const METHOD_GET_BLOCK_BY_HASH: &str = "eth_getBlockByHash";
const METHOD_GET_BLOCK_BY_NUMBER: &str = "eth_getBlockByNumber";
const METHOD_GET_CODE: &str = "eth_getCode";
const METHOD_GET_PROOF: &str = "eth_getProof";
const METHOD_GET_STORAGE_AT: &str = "eth_getStorageAt";
#[cfg(test)]
const METHOD_CALL: &str = "eth_call";

fn is_hedgeable_read(method: &str, params: &Value) -> bool {
    // Deliberately excludes reads such as eth_call where a successful hedge could mask
    // execution or revert semantics returned by a higher-priority provider.
    let params = params.as_array();
    match method {
        METHOD_CHAIN_ID => true,
        METHOD_GET_BLOCK_BY_HASH => params
            .and_then(|params| params.first())
            .is_some_and(is_block_hash),
        METHOD_GET_BLOCK_BY_NUMBER => params
            .and_then(|params| params.first())
            .is_some_and(is_finalized_tag),
        METHOD_GET_BALANCE | METHOD_GET_CODE => params
            .and_then(|params| params.get(1))
            .is_some_and(is_immutable_block_selector),
        METHOD_GET_STORAGE_AT | METHOD_GET_PROOF => params
            .and_then(|params| params.get(2))
            .is_some_and(is_immutable_block_selector),
        _ => false,
    }
}

fn is_immutable_block_selector(selector: &Value) -> bool {
    is_finalized_tag(selector)
        || selector
            .as_object()
            .and_then(|selector| selector.get("blockHash"))
            .is_some_and(is_block_hash)
}

fn is_finalized_tag(selector: &Value) -> bool {
    matches!(selector.as_str(), Some("safe" | "finalized"))
}

fn is_block_hash(value: &Value) -> bool {
    value.as_str().is_some_and(|value| {
        value.len() == 66
            && value.starts_with("0x")
            && value[2..].bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}

/// Wrapper of `FallbackProvider` for use in `hyperlane-ethereum`
/// The wrapper uses two distinct strategies to place requests to chains:
/// 1. multicast - the request will be sent to all the providers simultaneously and the first
///    successful response will be used.
///
/// 2. fallback  - the request will be sent to providers according to their priority and the
///    priority will be updated depending on success/failure. Explicitly allowlisted immutable
///    reads can optionally start one speculative fallback after a grace period.
///
/// Multicast strategy is used to submit transactions into the chain, namely with RPC method
/// `eth_sendRawTransaction` while fallback strategy is used for all the other RPC methods.
pub struct EthereumFallbackProvider<C, B> {
    /// Fallback provider
    pub provider: FallbackProvider<C, B>,
    /// If enabled and eth_getTransactionReceipt returns Ok(Value::null())
    /// we will try other providers and see if another provider returns something
    /// non-null
    pub consider_null_transaction_receipt: bool,
    hedge_config: Option<FallbackHedgeConfig>,
    hedge_metrics: Option<PrometheusClientMetrics>,
}

impl<C, B> EthereumFallbackProvider<C, B> {
    /// Create an Ethereum fallback provider with hedging disabled.
    pub fn new(provider: FallbackProvider<C, B>, consider_null_transaction_receipt: bool) -> Self {
        Self {
            provider,
            consider_null_transaction_receipt,
            hedge_config: None,
            hedge_metrics: None,
        }
    }

    /// Configure optional hedging and its metrics. `None` keeps legacy sequential behavior.
    pub fn with_hedging(
        mut self,
        config: Option<FallbackHedgeConfig>,
        metrics: Option<PrometheusClientMetrics>,
    ) -> Self {
        self.hedge_config = config;
        self.hedge_metrics = metrics;
        self
    }
}

enum AttemptResponse {
    Rpc(Result<Value, HttpClientError>),
    TimedOut,
}

struct HedgedAttempt {
    speculative: bool,
    priority: PrioritizedProviderInner,
    provider_host: String,
    response: AttemptResponse,
}

type HedgedAttemptFuture<'a> = Pin<Box<dyn Future<Output = HedgedAttempt> + Send + 'a>>;

enum HedgedRoundResult {
    Success(Value, bool),
    NonRetryable(ProviderError),
    Retryable(Vec<ProviderError>),
}

impl<C, B> Deref for EthereumFallbackProvider<C, B> {
    type Target = FallbackProvider<C, B>;

    fn deref(&self) -> &Self::Target {
        &self.provider
    }
}

impl<C, B> Debug for EthereumFallbackProvider<C, B>
where
    C: JsonRpcClient + PrometheusConfigExt,
{
    #[allow(clippy::get_first)] // TODO: `rustc` 1.80.1 clippy issue
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FallbackProvider")
            .field(
                "chain_name",
                &self
                    .inner
                    .providers
                    .get(0)
                    .map(|v| v.chain_name())
                    .unwrap_or("None"),
            )
            .field(
                "hosts",
                &self
                    .inner
                    .providers
                    .iter()
                    .map(|v| v.node_host())
                    .collect::<Vec<_>>()
                    .join(", "),
            )
            .finish()
    }
}

/// Errors specific to fallback provider.
#[derive(Error, Debug)]
pub enum FallbackError {
    /// All providers failed
    #[error("All providers failed. (Errors: {0:?})")]
    AllProvidersFailed(Vec<ProviderError>),
}

impl From<FallbackError> for ProviderError {
    fn from(src: FallbackError) -> Self {
        ProviderError::JsonRpcClientError(Box::new(src))
    }
}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
impl<C> JsonRpcClient for EthereumFallbackProvider<C, JsonRpcBlockGetter<C>>
where
    C: JsonRpcClient<Error = HttpClientError>
        + Into<JsonRpcBlockGetter<C>>
        + PrometheusConfigExt
        + Clone
        + 'static,
    JsonRpcBlockGetter<C>: BlockNumberGetter + 'static,
{
    type Error = ProviderError;

    // TODO: Refactor to use `FallbackProvider::call`
    #[instrument(skip(self, params))]
    async fn request<T, R>(&self, method: &str, params: T) -> Result<R, Self::Error>
    where
        T: Debug + Serialize + Send + Sync,
        R: DeserializeOwned,
    {
        if method == METHOD_SEND_RAW_TRANSACTION {
            self.multicast(method, params).await
        } else if method == METHOD_GET_TRANSACTION_RECEIPT && self.consider_null_transaction_receipt
        {
            self.fallback_transaction_receipt(method, params).await
        } else if let Some(config) = self.hedge_config.filter(|_| {
            serde_json::to_value(&params)
                .map(|params| is_hedgeable_read(method, &params))
                .unwrap_or(false)
        }) {
            self.fallback_hedged(method, params, config).await
        } else {
            self.fallback(method, params).await
        }
    }
}

impl<C> EthereumFallbackProvider<C, JsonRpcBlockGetter<C>>
where
    C: JsonRpcClient<Error = HttpClientError>
        + Into<JsonRpcBlockGetter<C>>
        + PrometheusConfigExt
        + Clone
        + 'static,
    JsonRpcBlockGetter<C>: BlockNumberGetter + 'static,
{
    async fn fallback_hedged<T, R>(
        &self,
        method: &str,
        params: T,
        config: FallbackHedgeConfig,
    ) -> Result<R, ProviderError>
    where
        T: Serialize,
        R: DeserializeOwned,
    {
        let params = serde_json::to_value(params)?;
        let request_started = Instant::now();
        let mut errors = Vec::new();

        while errors.len() <= 3 {
            if !errors.is_empty() {
                sleep(Duration::from_millis(100)).await;
            }

            let priorities = self.take_priorities_snapshot().await;
            match self
                .hedged_round(method, &params, &priorities, config)
                .await
            {
                HedgedRoundResult::Success(value, speculative) => {
                    let (winner, event) = if speculative {
                        ("hedge", "hedge_winner")
                    } else {
                        ("primary", "primary_winner")
                    };
                    self.increment_hedge_event(method, event);
                    self.observe_hedge_duration(method, winner, request_started);
                    return Ok(serde_json::from_value(value)?);
                }
                HedgedRoundResult::NonRetryable(error) => {
                    self.observe_hedge_duration(method, "error", request_started);
                    return Err(error);
                }
                HedgedRoundResult::Retryable(mut round_errors) => errors.append(&mut round_errors),
            }
        }

        self.observe_hedge_duration(method, "error", request_started);
        Err(FallbackError::AllProvidersFailed(errors).into())
    }

    async fn hedged_round(
        &self,
        method: &str,
        params: &Value,
        priorities: &[PrioritizedProviderInner],
        config: FallbackHedgeConfig,
    ) -> HedgedRoundResult {
        if priorities.is_empty() {
            return HedgedRoundResult::NonRetryable(ProviderError::CustomError(
                "Fallback provider has no configured providers".to_owned(),
            ));
        }

        let mut attempts = FuturesUnordered::new();
        let mut next_ordinal = 0;
        let mut errors = Vec::new();
        let mut grace: Pin<Box<Sleep>> = Box::pin(sleep(config.delay));
        let mut grace_expired = false;

        attempts.push(self.timed_provider_request(
            false,
            priorities[next_ordinal],
            method,
            params,
            config.attempt_timeout,
        ));
        next_ordinal = next_ordinal.saturating_add(1);

        loop {
            let attempt =
                if !grace_expired && attempts.len() == 1 && next_ordinal < priorities.len() {
                    tokio::select! {
                        attempt = attempts.next() => attempt,
                        () = &mut grace => {
                            self.increment_hedge_event(method, "start");
                            attempts.push(self.timed_provider_request(
                                true,
                                priorities[next_ordinal],
                                method,
                                params,
                                config.attempt_timeout,
                            ));
                            next_ordinal = next_ordinal.saturating_add(1);
                            grace_expired = true;
                            continue;
                        }
                    }
                } else {
                    attempts.next().await
                };
            let Some(attempt) = attempt else {
                return HedgedRoundResult::NonRetryable(ProviderError::CustomError(
                    "Fallback provider lost all active requests".to_owned(),
                ));
            };
            let response = match attempt.response {
                AttemptResponse::Rpc(response) => {
                    if response.is_err() {
                        self.handle_failed_provider(&attempt.priority).await;
                    }
                    categorize_client_response(&attempt.provider_host, method, response)
                }
                AttemptResponse::TimedOut => {
                    self.handle_failed_provider(&attempt.priority).await;
                    self.increment_hedge_event(method, "timeout");
                    errors.push(ProviderError::CustomError(format!(
                        "Fallback provider request to {} timed out",
                        attempt.provider_host
                    )));
                    self.refill_hedged_attempts(
                        &mut attempts,
                        &mut next_ordinal,
                        priorities,
                        method,
                        params,
                        config,
                    );
                    if attempts.is_empty() {
                        return HedgedRoundResult::Retryable(errors);
                    }
                    continue;
                }
            };

            match response {
                CategorizedResponse::IsOk(value) => {
                    self.cancel_attempts(method, attempts.len());
                    return HedgedRoundResult::Success(value, attempt.speculative);
                }
                CategorizedResponse::RetryableErr(error)
                | CategorizedResponse::RateLimitErr(error) => errors.push(error.into()),
                CategorizedResponse::NonRetryableErr(error) => {
                    self.cancel_attempts(method, attempts.len());
                    return HedgedRoundResult::NonRetryable(error.into());
                }
            }

            self.refill_hedged_attempts(
                &mut attempts,
                &mut next_ordinal,
                priorities,
                method,
                params,
                config,
            );
            if attempts.is_empty() {
                return HedgedRoundResult::Retryable(errors);
            }
            if attempts.len() == 1 && !grace_expired {
                grace = Box::pin(sleep(config.delay));
            }
        }
    }

    fn refill_hedged_attempts<'a>(
        &'a self,
        attempts: &mut FuturesUnordered<HedgedAttemptFuture<'a>>,
        next_ordinal: &mut usize,
        priorities: &'a [PrioritizedProviderInner],
        method: &'a str,
        params: &'a Value,
        config: FallbackHedgeConfig,
    ) {
        if *next_ordinal >= priorities.len() {
            return;
        }
        let speculative = !attempts.is_empty();
        if speculative {
            self.increment_hedge_event(method, "start");
        }
        attempts.push(self.timed_provider_request(
            speculative,
            priorities[*next_ordinal],
            method,
            params,
            config.attempt_timeout,
        ));
        *next_ordinal = (*next_ordinal).saturating_add(1);
    }

    fn cancel_attempts(&self, method: &str, count: usize) {
        for _ in 0..count {
            self.increment_hedge_event(method, "cancellation");
        }
    }

    fn increment_hedge_event(&self, method: &str, event: &str) {
        if let Some(metrics) = &self.hedge_metrics {
            metrics.increment_fallback_hedge_event(self.hedge_chain(), method, event);
        }
    }

    fn observe_hedge_duration(&self, method: &str, winner: &str, started: Instant) {
        if let Some(metrics) = &self.hedge_metrics {
            metrics.observe_fallback_hedge_duration(
                self.hedge_chain(),
                method,
                winner,
                started.elapsed(),
            );
        }
    }

    fn hedge_chain(&self) -> &str {
        self.inner
            .providers
            .first()
            .map(PrometheusConfigExt::chain_name)
            .unwrap_or("unknown")
    }

    fn timed_provider_request<'a>(
        &'a self,
        speculative: bool,
        priority: PrioritizedProviderInner,
        method: &'a str,
        params: &'a Value,
        attempt_timeout: Duration,
    ) -> HedgedAttemptFuture<'a> {
        Box::pin(async move {
            let provider = &self.inner.providers[priority.index];
            let provider_host = provider.node_host().to_owned();
            let response = match timeout(
                attempt_timeout,
                Self::provider_request(provider, method, params),
            )
            .await
            {
                Ok((_, response)) => {
                    let fallback = self.provider.clone();
                    let provider = provider.clone();
                    let _probe = tokio::spawn(async move {
                        if let Err(error) =
                            fallback.handle_stalled_provider(&priority, &provider).await
                        {
                            tracing::debug!(?error, "stalled_provider_probe_failed");
                        }
                    });
                    AttemptResponse::Rpc(response)
                }
                Err(_) => AttemptResponse::TimedOut,
            };
            HedgedAttempt {
                speculative,
                priority,
                provider_host,
                response,
            }
        })
    }

    async fn multicast<T, R>(&self, method: &str, params: T) -> Result<R, ProviderError>
    where
        T: Serialize,
        R: DeserializeOwned,
    {
        use CategorizedResponse::*;

        let params = serde_json::to_value(params).expect("valid");

        // retryable errors reported by providers
        let mut retryable_errors = vec![];

        // non-retryable errors reported by providers
        let mut non_retryable_errors = vec![];

        // retry 4 times if all providers returned a retryable error
        for i in 0..=3 {
            if i > 0 {
                // sleep starting from the second attempt
                sleep(Duration::from_millis(100)).await;
            }

            // future which visits all providers as they fulfill their requests
            let mut unordered = self.populate_unordered_future(method, &params);

            while let Some((provider_host, resp)) = unordered.next().await {
                let value = match categorize_client_response(provider_host.as_str(), method, resp) {
                    IsOk(v) => serde_json::from_value(v)?,
                    RetryableErr(e) | RateLimitErr(e) => {
                        retryable_errors.push(e.into());
                        continue;
                    }
                    NonRetryableErr(e) => {
                        non_retryable_errors.push(e.into());
                        continue;
                    }
                };

                // if we are here, it means one of the providers returned a successful result
                if !retryable_errors.is_empty() || !non_retryable_errors.is_empty() {
                    // we log a warning if we got errors from failed providers
                    let errors_count = retryable_errors
                        .len()
                        .saturating_add(non_retryable_errors.len());
                    warn!(errors_count, ?retryable_errors, ?non_retryable_errors, providers=?self.inner.providers, "multicast_request");
                }

                return Ok(value);
            }

            // if we are here, it means that all providers failed
            // if one of the errors was non-retryable, we stop doing retrying attempts
            if !non_retryable_errors.is_empty() {
                break;
            }
        }

        let errors_count = retryable_errors
            .len()
            .saturating_add(non_retryable_errors.len());
        warn!(errors_count, ?retryable_errors, ?non_retryable_errors, providers=?self.inner.providers, "multicast_request, all providers failed");

        retryable_errors.extend(non_retryable_errors);
        Err(FallbackError::AllProvidersFailed(retryable_errors).into())
    }

    async fn fallback<T, R>(&self, method: &str, params: T) -> Result<R, ProviderError>
    where
        T: Serialize,
        R: DeserializeOwned,
    {
        use CategorizedResponse::*;

        let params = serde_json::to_value(params).expect("valid");

        let mut errors: Vec<ProviderError> = vec![];
        // make sure we do at least 4 total retries.
        while errors.len() <= 3 {
            if !errors.is_empty() {
                sleep(Duration::from_millis(100)).await;
            }
            let priorities_snapshot = self.take_priorities_snapshot().await;
            for (idx, priority) in priorities_snapshot.iter().enumerate() {
                let provider = &self.inner.providers[priority.index];
                let fut = Self::provider_request(provider, method, &params);
                let (provider_host, resp) = fut.await;
                let _ = self.handle_stalled_provider(priority, provider).await;
                if resp.is_err() {
                    self.handle_failed_provider(priority).await;
                }
                tracing::debug!(
                    fallback_count = idx,
                    provider_index = priority.index,
                    provider_host = provider_host.as_str(),
                    method,
                    "fallback_request"
                );

                match categorize_client_response(provider_host.as_str(), method, resp) {
                    IsOk(v) => {
                        // Add log to identify content of v when no tx receipt is found
                        if v.is_null() {
                            tracing::debug!(
                                fallback_count = idx,
                                provider_index = priority.index,
                                provider_host = provider_host.as_str(),
                                method,
                                ?v,
                                "fallback_request: value is null"
                            );
                        }
                        return Ok(serde_json::from_value(v)?);
                    }
                    RetryableErr(e) | RateLimitErr(e) => errors.push(e.into()),
                    NonRetryableErr(e) => return Err(e.into()),
                }
            }
        }
        Err(FallbackError::AllProvidersFailed(errors).into())
    }

    async fn fallback_transaction_receipt<T, R>(
        &self,
        method: &str,
        params: T,
    ) -> Result<R, ProviderError>
    where
        T: Serialize,
        R: DeserializeOwned,
    {
        use CategorizedResponse::*;

        let params = serde_json::to_value(params).expect("valid");

        let mut priorities = self.take_priorities_snapshot().await;
        let mut errors: Vec<ProviderError> = vec![];

        // make sure we do at least 4 total retries.
        while errors.len() <= 3 && !priorities.is_empty() {
            if !errors.is_empty() {
                sleep(Duration::from_millis(200)).await;
            }

            let mut retry_priorities = Vec::with_capacity(priorities.len());
            for (idx, priority) in priorities.into_iter().enumerate() {
                let provider = &self.inner.providers[priority.index];
                let fut = Self::provider_request(provider, method, &params);
                let (provider_host, resp) = fut.await;
                let _ = self.handle_stalled_provider(&priority, provider).await;
                if resp.is_err() {
                    self.handle_failed_provider(&priority).await;
                }
                tracing::debug!(
                    fallback_count = idx,
                    provider_index = priority.index,
                    provider_host = provider_host.as_str(),
                    method,
                    ?resp,
                    "fallback_transaction_receipt"
                );

                match categorize_client_response(provider_host.as_str(), method, resp) {
                    NonRetryableErr(e) => return Err(e.into()),
                    RetryableErr(e) | RateLimitErr(e) => {
                        errors.push(e.into());
                        // if it is a retryable error, then we want to
                        // retry this provider
                        retry_priorities.push(priority);
                    }
                    IsOk(v) => {
                        // If we received null for transaction receipt
                        // we don't want to retry this provider
                        if v.is_null() {
                            continue;
                        }
                        return Ok(serde_json::from_value(v)?);
                    }
                }
            }
            priorities = retry_priorities;
        }

        Err(FallbackError::AllProvidersFailed(errors).into())
    }

    async fn provider_request<'a>(
        provider: &'a C,
        method: &'a str,
        params: &'a Value,
    ) -> (String, Result<Value, HttpClientError>) {
        let provider_host = provider.node_host().to_owned();
        let result = match params {
            Value::Null => provider.request(method, ()).await,
            _ => provider.request(method, params).await,
        };

        (provider_host, result)
    }

    fn populate_unordered_future<'a>(
        &'a self,
        method: &'a str,
        params: &'a Value,
    ) -> FuturesUnordered<impl Future<Output = (String, Result<Value, HttpClientError>)> + Sized + 'a>
    {
        let unordered = FuturesUnordered::new();
        self.inner
            .providers
            .iter()
            .for_each(|p| unordered.push(Self::provider_request(p, method, params)));
        unordered
    }
}
