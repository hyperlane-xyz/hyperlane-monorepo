use std::{
    ops::Deref,
    task::{Context, Poll},
};

use derive_new::new;
use hyperlane_core::rpc_clients::CoreFallbackProvider;
use tonic::client::GrpcService;

/// Wrapper of `FallbackProvider` for use in `hyperlane-cosmos`
#[derive(new)]
pub struct CosmosFallbackProvider<T>(CoreFallbackProvider<T>);

impl<T> Deref for CosmosFallbackProvider<T> {
    type Target = CoreFallbackProvider<T>;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl<T, ReqBody> GrpcService<ReqBody> for CosmosFallbackProvider<T>
where
    T: GrpcService<ReqBody> + Clone,
{
    type ResponseBody = T::ResponseBody;
    type Error = T::Error;
    type Future = T::Future;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        let mut provider = (*self.inner.providers)[0].clone();
        provider.poll_ready(cx)
    }

    fn call(&mut self, request: http::Request<ReqBody>) -> Self::Future {
        let mut provider = (*self.inner.providers)[0].clone();
        provider.call(request)
    }
}
