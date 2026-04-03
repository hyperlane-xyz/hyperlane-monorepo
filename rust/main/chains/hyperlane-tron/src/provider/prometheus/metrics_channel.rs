use std::fmt;
use std::future::Future;
use std::sync::Arc;
use std::task::{Context, Poll};

use hyperlane_metric::prometheus_metric::{PrometheusClientMetrics, PrometheusConfig};
use tonic::codegen::http::header::{HeaderName, HeaderValue};
use tonic::codegen::http::{Request, Response};
use tonic::GrpcMethod;
use tower::Service;

use super::metrics_future::MetricsChannelFuture;

/// Wrapper for instrumenting a tonic client channel with gRPC metrics.
pub struct MetricsChannel<T> {
    metrics: PrometheusClientMetrics,
    metrics_config: PrometheusConfig,
    custom_headers: Arc<Vec<(HeaderName, HeaderValue)>>,
    inner: T,
}

impl<T: fmt::Debug> fmt::Debug for MetricsChannel<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MetricsChannel")
            .field("metrics", &"PrometheusClientMetrics")
            .field("metrics_config", &self.metrics_config)
            .field(
                "custom_headers",
                &self
                    .custom_headers
                    .iter()
                    .map(|(name, _)| (name.clone(), HeaderValue::from_static("<redacted>")))
                    .collect::<Vec<_>>(),
            )
            .field("inner", &self.inner)
            .finish()
    }
}

impl<T> MetricsChannel<T> {
    /// Wrap a channel with metrics and optional custom headers injected on every request.
    pub fn new(
        inner: T,
        metrics: PrometheusClientMetrics,
        metrics_config: PrometheusConfig,
        custom_headers: Vec<(HeaderName, HeaderValue)>,
    ) -> Self {
        // increment provider metric count
        let chain_name = PrometheusConfig::chain_name(&metrics_config.chain);
        metrics.increment_provider_instance(chain_name);

        Self {
            inner,
            metrics,
            metrics_config,
            custom_headers: Arc::new(custom_headers),
        }
    }
}

impl<T> Drop for MetricsChannel<T> {
    fn drop(&mut self) {
        // decrement provider metric count
        let chain_name = PrometheusConfig::chain_name(&self.metrics_config.chain);
        self.metrics.decrement_provider_instance(chain_name);
    }
}

impl<T: Clone> Clone for MetricsChannel<T> {
    fn clone(&self) -> Self {
        Self::new(
            self.inner.clone(),
            self.metrics.clone(),
            self.metrics_config.clone(),
            (*self.custom_headers).clone(),
        )
    }
}

impl<I, O, T> Service<Request<I>> for MetricsChannel<T>
where
    T: Service<Request<I>, Response = Response<O>>,
    T::Future: Future<Output = Result<T::Response, T::Error>>,
{
    type Response = T::Response;
    type Error = T::Error;
    type Future = MetricsChannelFuture<T::Future>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, mut req: Request<I>) -> Self::Future {
        for (name, value) in self.custom_headers.iter() {
            req.headers_mut().insert(name.clone(), value.clone());
        }
        let (_, method) = req
            .extensions()
            .get::<GrpcMethod>()
            .map_or(("", ""), |gm| (gm.service(), gm.method()));
        MetricsChannelFuture::new(
            method.into(),
            self.metrics.clone(),
            self.metrics_config.clone(),
            self.inner.call(req),
        )
    }
}
