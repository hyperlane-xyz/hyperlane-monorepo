use std::error::Error;

use async_trait::async_trait;

use hyperlane_core::{
    rpc_clients::{BlockNumberGetter, FallbackProvider},
    ChainCommunicationError, ChainResult,
};
use hyperlane_metric::prometheus_metric::{
    ClientConnectionType, PrometheusClientMetrics, PrometheusConfig,
};
use snarkvm_console_account::{DeserializeOwned, Itertools};
use url::Url;

use crate::provider::{
    metric::MetricHttpClient, AleoClient, BaseHttpClient, HttpClient, HttpClientBuilder,
    JWTBaseHttpClient, RpcClient,
};
use crate::DelegatedProverAuthError;

#[derive(Clone, Copy, Debug)]
enum RetryPolicy {
    AllErrors,
    DelegatedProver,
}

fn delegated_prover_auth_status(error: &ChainCommunicationError) -> Option<reqwest::StatusCode> {
    let mut source: Option<&(dyn Error + 'static)> = Some(error);
    while let Some(error) = source {
        if let Some(error) = error.downcast_ref::<DelegatedProverAuthError>() {
            return error.status();
        }
        source = error.source();
    }
    None
}

fn should_retry_delegated_prover(error: &ChainCommunicationError) -> bool {
    !matches!(
        delegated_prover_auth_status(error),
        Some(
            reqwest::StatusCode::UNAUTHORIZED
                | reqwest::StatusCode::FORBIDDEN
                | reqwest::StatusCode::LENGTH_REQUIRED
                | reqwest::StatusCode::TOO_MANY_REQUESTS
        )
    )
}

/// Fallback Http Client that tries multiple RpcClients in order
#[derive(Clone, Debug)]
pub struct FallbackHttpClient<C: AleoClient = BaseHttpClient> {
    fallback: FallbackProvider<RpcClient<MetricHttpClient<C>>, RpcClient<MetricHttpClient<C>>>,
    retry_policy: RetryPolicy,
}

impl<C: AleoClient> FallbackHttpClient<C> {
    /// Creates a new FallbackHttpClient from a list of base urls
    pub fn new<Builder: HttpClientBuilder<Client = C>>(
        urls: Vec<Url>,
        metrics: PrometheusClientMetrics,
        chain: Option<hyperlane_metric::prometheus_metric::ChainInfo>,
        network: u16,
    ) -> ChainResult<Self> {
        Self::new_with_retry_policy::<Builder>(
            urls,
            metrics,
            chain,
            network,
            RetryPolicy::AllErrors,
        )
    }

    fn new_with_retry_policy<Builder: HttpClientBuilder<Client = C>>(
        urls: Vec<Url>,
        metrics: PrometheusClientMetrics,
        chain: Option<hyperlane_metric::prometheus_metric::ChainInfo>,
        network: u16,
        retry_policy: RetryPolicy,
    ) -> ChainResult<Self> {
        let clients = urls
            .into_iter()
            .map(|url| {
                let metrics_config =
                    PrometheusConfig::from_url(&url, ClientConnectionType::Rpc, chain.clone());
                MetricHttpClient::new::<Builder>(url, metrics.clone(), metrics_config, network)
            })
            .collect::<ChainResult<Vec<_>>>()?
            .into_iter()
            .map(RpcClient::new)
            .collect_vec();
        let fallback = FallbackProvider::new(clients);
        Ok(Self {
            fallback,
            retry_policy,
        })
    }
}

impl FallbackHttpClient<JWTBaseHttpClient> {
    /// Creates a fallback client for delegated proving. HTTP responses that an
    /// immediate identical retry cannot fix are attempted once per endpoint.
    pub fn new_delegated_prover(
        urls: Vec<Url>,
        metrics: PrometheusClientMetrics,
        chain: Option<hyperlane_metric::prometheus_metric::ChainInfo>,
        network: u16,
    ) -> ChainResult<Self> {
        Self::new_with_retry_policy::<JWTBaseHttpClient>(
            urls,
            metrics,
            chain,
            network,
            RetryPolicy::DelegatedProver,
        )
    }
}

#[async_trait]
impl<C: HttpClient + std::fmt::Debug + Send + Sync> BlockNumberGetter for RpcClient<C> {
    async fn get_block_number(&self) -> ChainResult<u64> {
        let height = self.get_latest_height().await?;
        Ok(height as u64)
    }
}

#[async_trait]
impl<C: AleoClient> HttpClient for FallbackHttpClient<C> {
    /// Makes a GET request to the API
    async fn request<T: DeserializeOwned + Send>(
        &self,
        path: &str,
        query: impl Into<Option<serde_json::Value>> + Send,
    ) -> ChainResult<T> {
        let query = query.into();
        let request = |inner: RpcClient<MetricHttpClient<C>>| {
            let path = path.to_string();
            let query = query.clone();
            let future = async move { inner.request(&path, query).await };
            Box::pin(future) as _
        };
        match self.retry_policy {
            RetryPolicy::AllErrors => self.fallback.call(request).await,
            RetryPolicy::DelegatedProver => {
                self.fallback
                    .call_with_retry_predicate(request, should_retry_delegated_prover)
                    .await
            }
        }
    }

    async fn request_optional<T: DeserializeOwned + Send>(
        &self,
        path: &str,
        query: impl Into<Option<serde_json::Value>> + Send,
    ) -> ChainResult<Option<T>> {
        let query = query.into();
        self.fallback
            .call_optional(|inner| {
                let path = path.to_string();
                let query = query.clone();
                let future = async move { inner.request_optional(&path, query).await };
                Box::pin(future)
            })
            .await
    }

    /// Makes a POST request to the API
    async fn request_post<T: DeserializeOwned + Send>(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> ChainResult<T> {
        let request = |inner: RpcClient<MetricHttpClient<C>>| {
            let path = path.to_string();
            let body = body.clone();
            let future = async move { inner.request_post(&path, &body).await };
            Box::pin(future) as _
        };
        match self.retry_policy {
            RetryPolicy::AllErrors => self.fallback.call(request).await,
            RetryPolicy::DelegatedProver => {
                self.fallback
                    .call_with_retry_predicate(request, should_retry_delegated_prover)
                    .await
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        io::{ErrorKind, Read, Write},
        net::TcpListener,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
        thread,
        time::{Duration, Instant},
    };

    use hyperlane_metric::prometheus_metric::PrometheusClientMetrics;
    use serde_json::Value;
    use url::Url;

    use super::{FallbackHttpClient, HttpClient, JWTBaseHttpClient};

    async fn assert_auth_attempts(status: reqwest::StatusCode, expected_attempts: usize) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let attempts = Arc::new(AtomicUsize::new(0));
        let server_attempts = attempts.clone();
        let server = thread::spawn(move || {
            let started = Instant::now();
            while started.elapsed() < Duration::from_secs(1) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream.set_nonblocking(false).unwrap();
                        let mut buffer = [0; 4096];
                        stream.read(&mut buffer).unwrap();
                        server_attempts.fetch_add(1, Ordering::Relaxed);
                        let response = format!(
                            "HTTP/1.1 {} {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                            status.as_u16(),
                            status.canonical_reason().unwrap()
                        );
                        stream.write_all(response.as_bytes()).unwrap();
                    }
                    Err(error) if error.kind() == ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("test server failed: {error}"),
                }
            }
        });
        let url = Url::parse(&format!(
            "http://{address}/v2?custom_rpc_header=x-auth-url:http%3A%2F%2F{address}%2Fauth"
        ))
        .unwrap();
        let client = FallbackHttpClient::<JWTBaseHttpClient>::new_delegated_prover(
            vec![url],
            PrometheusClientMetrics::default(),
            None,
            0,
        )
        .unwrap();

        let result = client.request::<Value>("pubkey", None).await;

        assert!(result.is_err());
        server.join().unwrap();
        assert_eq!(attempts.load(Ordering::Relaxed), expected_attempts);
    }

    #[tokio::test]
    async fn delegated_prover_does_not_immediately_retry_terminal_http_statuses() {
        for status in [
            reqwest::StatusCode::UNAUTHORIZED,
            reqwest::StatusCode::FORBIDDEN,
            reqwest::StatusCode::LENGTH_REQUIRED,
            reqwest::StatusCode::TOO_MANY_REQUESTS,
        ] {
            assert_auth_attempts(status, 1).await;
        }
    }

    #[tokio::test]
    async fn delegated_prover_retains_retries_for_server_errors() {
        assert_auth_attempts(reqwest::StatusCode::INTERNAL_SERVER_ERROR, 4).await;
    }
}
