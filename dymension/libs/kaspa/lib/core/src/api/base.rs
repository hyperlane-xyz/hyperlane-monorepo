use api_rs::apis::configuration::Configuration;

use governor::{DefaultDirectRateLimiter, Quota, RateLimiter};
use reqwest_middleware::{ClientBuilder, ClientWithMiddleware};
use reqwest_retry::policies::ExponentialBackoff;
use std::sync::Arc;
use std::time::Duration;
use std::{error::Error, num::NonZeroU32};
use url::Url;

use kaspa_wrpc_client::{
    client::{ConnectOptions, ConnectStrategy},
    prelude::{NetworkId, NetworkType},
    KaspaRpcClient, Resolver, WrpcEncoding,
};

struct FooRateLimiter {
    limiter: Arc<DefaultDirectRateLimiter>,
}

impl reqwest_ratelimit::RateLimiter for FooRateLimiter {
    async fn acquire_permit(&self) {
        self.limiter.until_ready().await;
    }
}

pub struct RateLimitConfig {
    pub max_req_per_second: u32,
}

impl RateLimitConfig {
    pub fn new(max_req_per_minute: u32) -> Self {
        Self {
            max_req_per_second: max_req_per_minute,
        }
    }
    pub fn default() -> Self {
        Self::new(10)
    }
}

pub fn get_client(config: RateLimitConfig) -> ClientWithMiddleware {
    let base = reqwest::Client::new();
    let governor_limiter = RateLimiter::direct(Quota::per_second(
        NonZeroU32::new(config.max_req_per_second).unwrap(),
    ));
    let rl = FooRateLimiter {
        limiter: Arc::new(governor_limiter),
    };
    let client = ClientBuilder::new(base)
        .with(reqwest_ratelimit::all(rl))
        .with(reqwest_retry::RetryTransientMiddleware::new_with_policy(
            ExponentialBackoff::builder()
                .retry_bounds(Duration::from_millis(200), Duration::from_secs(10))
                .build_with_max_retries(10),
        ))
        .build();
    client
}

pub fn get_config(url: &str, client: ClientWithMiddleware) -> Configuration {
    Configuration {
        base_path: url.to_string(),
        user_agent: Some("OpenAPI-Generator/a6a9569/rust".to_owned()),
        client: client,
        basic_auth: None,
        oauth_access_token: None,
        bearer_access_token: None,
        api_key: None,
    }
}
