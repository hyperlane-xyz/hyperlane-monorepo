use std::{
    fmt::Debug,
    future::Future,
    ops::Deref,
    pin::Pin,
    task::{Context, Poll},
    time::Duration,
};

use async_trait::async_trait;
use derive_new::new;
use hyperlane_core::rpc_clients::{BlockNumberGetter, FallbackProvider};
use tokio::time::sleep;
use tonic::client::GrpcService;
use tracing::warn_span;

use crate::HyperlaneCosmosError;

/// Wrapper of `FallbackProvider` for use in `hyperlane-cosmos`
#[derive(new, Clone)]
pub struct CosmosFallbackProvider<T>(FallbackProvider<T>);

impl<T> Deref for CosmosFallbackProvider<T> {
    type Target = FallbackProvider<T>;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

#[async_trait]
impl<T, ReqBody> GrpcService<ReqBody> for CosmosFallbackProvider<T>
where
    T: GrpcService<ReqBody> + Clone + Debug + Into<Box<dyn BlockNumberGetter>> + 'static,
    <T as GrpcService<ReqBody>>::Error: Into<HyperlaneCosmosError>,
    ReqBody: Clone + 'static,
{
    type ResponseBody = T::ResponseBody;
    type Error = HyperlaneCosmosError;
    type Future =
        Pin<Box<dyn Future<Output = Result<http::Response<Self::ResponseBody>, Self::Error>>>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        let mut provider = (*self.inner.providers)[0].clone();
        provider
            .poll_ready(cx)
            .map_err(Into::<HyperlaneCosmosError>::into)
    }

    fn call(&mut self, request: http::Request<ReqBody>) -> Self::Future {
        // use CategorizedResponse::*;
        let request = clone_request(&request);
        let cloned_self = self.clone();
        let f = async move {
            let mut errors = vec![];
            // make sure we do at least 4 total retries.
            while errors.len() <= 3 {
                if !errors.is_empty() {
                    sleep(Duration::from_millis(100)).await
                }
                let priorities_snapshot = cloned_self.take_priorities_snapshot().await;
                for (idx, priority) in priorities_snapshot.iter().enumerate() {
                    let mut provider = cloned_self.inner.providers[priority.index].clone();
                    let resp = provider.call(clone_request(&request)).await;
                    cloned_self
                        .handle_stalled_provider(priority, &provider)
                        .await;
                    let _span =
                        warn_span!("request", fallback_count=%idx, provider_index=%priority.index, ?provider).entered();

                    match resp {
                        Ok(r) => return Ok(r),
                        Err(e) => errors.push(e.into()),
                    }
                }
            }

            Err(HyperlaneCosmosError::FallbackProvidersFailed(errors))
        };
        Box::pin(f)
    }
}

fn clone_request<ReqBody>(request: &http::Request<ReqBody>) -> http::Request<ReqBody>
where
    ReqBody: Clone + 'static,
{
    let builder = http::Request::builder()
        .uri(request.uri().clone())
        .method(request.method().clone())
        .version(request.version());
    let builder = request.headers().iter().fold(builder, |builder, (k, v)| {
        builder.header(k.clone(), v.clone())
    });
    builder.body(request.body().clone()).unwrap()
}
