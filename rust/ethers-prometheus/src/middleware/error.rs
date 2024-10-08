use std::error::Error;
use std::fmt::{Debug, Display, Formatter};

use ethers::prelude::FromErr;

/// For now this is just a thin wrapper around the underlying error type. Might
/// want to extend this later.
pub struct PrometheusMiddlewareError<E>(E);

impl<E: Debug> Debug for PrometheusMiddlewareError<E> {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

impl<E: Display> Display for PrometheusMiddlewareError<E> {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

impl<E: Error> Error for PrometheusMiddlewareError<E> {}

impl<E> FromErr<E> for PrometheusMiddlewareError<E> {
    fn from(src: E) -> Self {
        Self(src)
    }
}

impl<E> From<E> for PrometheusMiddlewareError<E> {
    fn from(e: E) -> Self {
        Self(e)
    }
}
