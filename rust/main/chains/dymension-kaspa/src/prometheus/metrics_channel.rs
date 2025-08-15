/// TODO: copy pasted from `chains/hyperlane-kaspa/src/prometheus`
/// refactore shared logic
use std::future::Future;
use std::task::{Context, Poll};

use hyperlane_metric::prometheus_metric::{PrometheusClientMetrics, PrometheusConfig};
use tonic::codegen::http::{Request, Response};
use tonic::GrpcMethod;
use tower::Service;

use super::metrics_future::MetricsChannelFuture;

#[derive(Debug)]
/// Wrapper for instrumenting a tonic client channel with gRPC metrics.
pub struct MetricsChannel<T> {
    metrics: PrometheusClientMetrics,
    metrics_config: PrometheusConfig,
    inner: T,
}

impl<T> MetricsChannel<T> {
    /// Wrap a channel so that sending RPCs over it increments gRPC client
    /// Prometeus metrics.
    pub fn new(
        inner: T,
        metrics: PrometheusClientMetrics,
        metrics_config: PrometheusConfig,
    ) -> Self {
        // increment provider metric count
        let chain_name = PrometheusConfig::chain_name(&metrics_config.chain);
        metrics.increment_provider_instance(chain_name);

        Self {
            inner,
            metrics,
            metrics_config,
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

    fn call(&mut self, req: Request<I>) -> Self::Future {
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
