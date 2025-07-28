/// TODO: copy pasted from `chains/hyperlane-kaspa/src/prometheus`
/// refactore shared logic
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Instant;

use hyperlane_metric::prometheus_metric::{PrometheusClientMetrics, PrometheusConfig};
use pin_project::pin_project;
use tonic::codegen::http::response;
use tonic::Code;

/// This is only needed to capture the result of the future
#[pin_project]
pub struct MetricsChannelFuture<F> {
    method: String,
    metrics: PrometheusClientMetrics,
    metrics_config: PrometheusConfig,
    started_at: Option<Instant>,
    #[pin]
    inner: F,
}

impl<F> MetricsChannelFuture<F> {
    pub fn new(
        method: String,
        metrics: PrometheusClientMetrics,
        metrics_config: PrometheusConfig,
        inner: F,
    ) -> Self {
        Self {
            started_at: None,
            method,
            metrics,
            metrics_config,
            inner,
        }
    }
}

impl<F, B, E> Future for MetricsChannelFuture<F>
where
    F: Future<Output = Result<response::Response<B>, E>>,
{
    type Output = F::Output;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.project();

        let started_at = this.started_at.get_or_insert_with(Instant::now);

        if let Poll::Ready(v) = this.inner.poll(cx) {
            let code = v.as_ref().map_or(Code::Unknown, |resp| {
                resp.headers()
                    .get("grpc-status")
                    .map(|s| Code::from_bytes(s.as_bytes()))
                    .unwrap_or(Code::Ok)
            });
            this.metrics.increment_metrics(
                this.metrics_config,
                this.method,
                *started_at,
                code == Code::Ok,
            );

            Poll::Ready(v)
        } else {
            Poll::Pending
        }
    }
}
