use api_rs::apis::configuration::Configuration;

use governor::{DefaultDirectRateLimiter, Quota, RateLimiter};
use std::time::Duration;
use reqwest_middleware::ClientBuilder;
use std::{error::Error, num::NonZeroU32};
use std::sync::Arc;
use url::Url;

use kaspa_wrpc_client::{
    client::{ConnectOptions,ConnectStrategy},
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

pub fn get_config(url: &Url) -> Configuration {
    // 1 req per sec
    let governor_limiter = RateLimiter::direct(Quota::per_second(NonZeroU32::new(1).unwrap()));
    let rl = FooRateLimiter {
        limiter: Arc::new(governor_limiter),
    };
    let client = ClientBuilder::new(reqwest::Client::new())
        .with(reqwest_ratelimit::all(rl))
        .build();
    // let client = ClientBuilder::new(reqwest::Client::new()).build();
    let raw_base = "https://api-tn10.kaspa.org".to_string(); // TODO: need to use passed url!
                                                             // let url_base = url.to_string();
    Configuration {
        base_path: raw_base,
        user_agent: Some("OpenAPI-Generator/a6a9569/rust".to_owned()),
        client: client,
        basic_auth: None,
        oauth_access_token: None,
        bearer_access_token: None,
        api_key: None,
    }
}

pub async fn get_local_testnet_client() ->  Result<KaspaRpcClient, Box<dyn Error>> {

    // Select encoding method to use, depending on node settings
    let encoding = WrpcEncoding::Borsh;

    // If you want to connect to your own node, define your node address and wRPC port using let url = Some("ws://0.0.0.0:17110")
    // Verify your Kaspa node is runnning with --rpclisten-borsh=0.0.0.0:17110 parameter
    let url = Some("ws://127.0.0.1:17210"); // TODO: factor out
    let resolver = Some(Resolver::default());
    // Define the network your Kaspa node is connected to
    // You can select NetworkType::Mainnet, NetworkType::Testnet, NetworkType::Devnet, NetworkType::Simnet
    let network_type = NetworkType::Testnet;
    let selected_network = Some(NetworkId::with_suffix(network_type, 10));

    // Advanced options
    let subscription_context = None;

    // Create new wRPC client with parameters defined above
    let client = KaspaRpcClient::new(
        encoding,
        url,
        resolver,
        selected_network,
        subscription_context,
    )?;

        // Advanced connection options
    let timeout = 5_000;
    let options = ConnectOptions {
        block_async_connect: true,
        connect_timeout: Some(Duration::from_millis(timeout)),
        strategy: ConnectStrategy::Fallback,
        ..Default::default()
    };

    // Connect to selected Kaspa node
    client.connect(Some(options)).await?;

    // return client
    Ok(client)
}
