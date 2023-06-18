use ethers::prelude::FromErr;
use std::error::Error;
use std::fmt::{Debug, Display, Formatter};

pub struct ClientMiddlewareError<E>(E);

impl<E: Debug> Debug for ClientMiddlewareError<E> {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

impl<E: Display> Display for ClientMiddlewareError<E> {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

impl<E: Error> Error for ClientMiddlewareError<E> {}

impl<E> FromErr<E> for ClientMiddlewareError<E> {
    fn from(src: E) -> Self {
        Self(src)
    }
}

impl<E> From<E> for ClientMiddlewareError<E> {
    fn from(e: E) -> Self {
        Self(e)
    }
}
