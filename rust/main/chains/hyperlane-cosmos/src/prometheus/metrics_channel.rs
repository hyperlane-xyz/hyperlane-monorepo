use std::future::Future;
use std::num::NonZeroUsize;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Instant;

use derive_new::new;
use hyperlane_metric::prometheus_metric::{PrometheusClientMetrics, PrometheusConfig};
use pin_project::pin_project;
use tonic::codegen::http::{Request, Response};
use tonic::{Code, GrpcMethod};
use tower::Service;

use super::metrics_future::MetricsChannelFuture;

#[derive(Clone, Debug)]
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
        Self {
            inner,
            metrics,
            metrics_config,
        }
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
        let (service, method) = req
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
