use api_rs::apis::configuration::Configuration;

use governor::{DefaultDirectRateLimiter, Quota, RateLimiter};
use reqwest_middleware::{ClientBuilder, ClientWithMiddleware};
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

pub fn get_client() -> ClientWithMiddleware {
    let base = reqwest::Client::new();
    // 1 req per sec
    // let governor_limiter = RateLimiter::direct(Quota::per_second(NonZeroU32::new(1).unwrap()));
    // let rl = FooRateLimiter {
    //     limiter: Arc::new(governor_limiter),
    // };
    let client = ClientBuilder::new(base)
        // .with(reqwest_ratelimit::all(rl))
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
