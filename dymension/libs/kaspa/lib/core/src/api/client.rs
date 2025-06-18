use api_rs::apis::configuration::Configuration;

use governor::{DefaultDirectRateLimiter, Quota, RateLimiter};

use reqwest_middleware::{ClientBuilder, ClientWithMiddleware};
use std::future::Future;
use std::num::NonZeroU32;
use std::sync::Arc;
use std::time::Duration;
use url::Url;

struct FooRateLimiter {
    limiter: Arc<DefaultDirectRateLimiter>,
}

impl reqwest_ratelimit::RateLimiter for FooRateLimiter {
    async fn acquire_permit(&self) {
        self.limiter.until_ready().await;
    }
}

pub fn get_config(url: &Url) -> Configuration {
    // 1 req per sec
    let governor_limiter = RateLimiter::direct(Quota::per_second(NonZeroU32::new(1).unwrap()));
    let rl = FooRateLimiter {
        limiter: Arc::new(governor_limiter),
    };
    let client = ClientBuilder::new(reqwest::Client::new())
        .with(reqwest_ratelimit::all(rl))
        .build();
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
