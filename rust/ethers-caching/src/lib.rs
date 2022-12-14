use std::collections::HashMap;
use std::error::Error;
use std::fmt::{Debug, Display, Formatter};
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use derive_builder::Builder;
use ethers::prelude::{FromErr, Middleware, U64};
use lazy_static::lazy_static;
use tokio::sync::RwLock;

lazy_static! {
    static ref CACHE: RwLock<HashMap<String, Arc<ChainCache>>> = Default::default();
}

enum CacheValue<T> {
    Uncached,
    Cached { value: T, since: Instant },
}

impl<T> Default for CacheValue<T> {
    fn default() -> Self {
        Self::Uncached
    }
}

#[derive(Default)]
struct ChainCache {
    latest_block: RwLock<CacheValue<U64>>,
}

impl ChainCache {
    async fn by_key(key: &str) -> Arc<Self> {
        let cache = CACHE.read().await;
        if let Some(entry) = cache.get(key) {
            // cache already exists
            entry.clone()
        } else {
            // cache did not exist
            drop(cache); // acquire a write-lock
            let mut cache = CACHE.write().await;
            if let Some(entry) = cache.get(key) {
                // it exists now
                entry.clone()
            } else {
                // still does not exist, so let's make it now that we have a write lock
                let entry = Arc::new(Self::default());
                cache.insert(key.to_owned(), entry.clone());
                entry
            }
        }
    }
}

#[derive(Builder, Debug)]
pub struct CachingMiddlewareConfig {
    /// The key by which to cache this data. Be very careful to not accidentally
    /// cross wires.
    cache_key: String,
    /// The max age to use if the specific max age is not specified.
    default_max_age: Duration,
    /// How long to cache the latest block for
    #[builder(setter(into, strip_option), default)]
    latest_block: Option<Duration>,
}

#[derive(Debug)]
pub struct CachingMiddleware<P> {
    inner: P,
    // metrics?
    config: CachingMiddlewareConfig,
}

impl<P> CachingMiddleware<P> {
    pub fn new(inner: P, config: CachingMiddlewareConfig) -> Self {
        Self { inner, config }
    }
}

pub struct CachingMiddlewareError<E>(E);

impl<E: Debug> Debug for CachingMiddlewareError<E> {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

impl<E: Display> Display for CachingMiddlewareError<E> {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

impl<E: Error> Error for CachingMiddlewareError<E> {}

impl<E> FromErr<E> for CachingMiddlewareError<E> {
    fn from(src: E) -> Self {
        Self(src)
    }
}

impl<E> From<E> for CachingMiddlewareError<E> {
    fn from(e: E) -> Self {
        Self(e)
    }
}

#[async_trait]
impl<P: Middleware> Middleware for CachingMiddleware<P> {
    type Error = CachingMiddlewareError<P::Error>;
    type Provider = P::Provider;
    type Inner = P;

    fn inner(&self) -> &Self::Inner {
        &self.inner
    }

    async fn get_block_number(&self) -> Result<U64, Self::Error> {
        CachingMiddleware::get_block_number(self).await
    }
}

macro_rules! cached_fn {
    ($fn_name:ident, $value_name:ident, $type:ty) => {
        async fn $fn_name(&self) -> Result<$type, CachingMiddlewareError<P::Error>> {
            let cache = ChainCache::by_key(&self.config.cache_key).await;

            if let CacheValue::Cached { ref value, since } = *cache.$value_name.read().await {
                let max_age = self
                    .config
                    .$value_name
                    .unwrap_or(self.config.default_max_age);
                if Instant::now().duration_since(since) < max_age {
                    return Ok(value.clone());
                }
            }

            // There is an edge case if using multi-threaded tokio where two requests will
            // be made at the same time and both then make it to this step. Should
            // be fairy rare and impossible with single-threaded tokio. Consequence
            // of this race condition is making more than one call in sequence
            // (instead of parallel) and updating the value n times.
            let mut cached_value = cache.$value_name.write().await;

            let res = self.inner.$fn_name().await.map_err(Into::into);
            if let Ok(value) = &res {
                *cached_value = CacheValue::Cached {
                    value: value.clone(),
                    since: Instant::now(),
                };
            }

            // we now free the write lock which allows readers to see the new value (or make
            // a new query if there was an error).
            res
        }
    };
}

impl<P: Middleware> CachingMiddleware<P> {
    cached_fn!(get_block_number, latest_block, U64);
}
