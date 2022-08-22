use async_trait::async_trait;
use ethers::prelude::*;
use std::sync::Arc;
use std::time::Duration;

use abacus_core::{ContractLocator, Signers};
use ethers_prometheus::{PrometheusMiddleware, PrometheusMiddlewareConf, ProviderMetrics};
use reqwest::{Client, Url};

use crate::{Connection, RetryingProvider};

// This should be whatever the prometheus scrape interval is
const METRICS_SCRAPE_INTERVAL: Duration = Duration::from_secs(60);
const HTTP_CLIENT_TIMEOUT: Duration = Duration::from_secs(60);

/// A trait for dynamic trait creation with provider initialization.
#[async_trait]
pub trait MakeableWithProvider {
    /// The type that will be created.
    type Output;

    /// Construct a new instance of the associated trait using a connection config.
    /// This is the first step and will wrap the provider with metrics and a signer as needed.
    async fn make_with_connection(
        &self,
        conn: Connection,
        locator: &ContractLocator,
        signer: Option<Signers>,
        metrics: Option<(ProviderMetrics, PrometheusMiddlewareConf)>,
    ) -> eyre::Result<Self::Output> {
        Ok(match conn {
            Connection::Http { url } => {
                let client = Client::builder().timeout(HTTP_CLIENT_TIMEOUT).build()?;
                let http_provider = Http::new_with_client(url.parse::<Url>()?, client);
                let retrying_http_provider: RetryingProvider<Http> =
                    RetryingProvider::new(http_provider, None, None);
                self.wrap_with_metrics(retrying_http_provider, locator, signer, metrics)
                    .await?
            }
            Connection::Ws { url } => {
                let ws = Ws::connect(url).await?;
                self.wrap_with_metrics(ws, locator, signer, metrics).await?
            }
        })
    }

    /// Wrap the provider creation with metrics if provided; this is the second step
    async fn wrap_with_metrics<P>(
        &self,
        client: P,
        locator: &ContractLocator,
        signer: Option<Signers>,
        metrics: Option<(ProviderMetrics, PrometheusMiddlewareConf)>,
    ) -> eyre::Result<Self::Output>
    where
        P: JsonRpcClient + 'static,
    {
        let provider = Provider::new(client);
        Ok(if let Some(metrics) = metrics {
            let provider = Arc::new(PrometheusMiddleware::new(provider, metrics.0, metrics.1));
            tokio::spawn(provider.start_updating_on_interval(METRICS_SCRAPE_INTERVAL));
            self.wrap_with_signer(provider, locator, signer).await?
        } else {
            self.wrap_with_signer(provider, locator, signer).await?
        })
    }

    /// Wrap the provider creation with a signing provider if signers were provided; this is the third step.
    async fn wrap_with_signer<M>(
        &self,
        provider: M,
        locator: &ContractLocator,
        signer: Option<Signers>,
    ) -> eyre::Result<Self::Output>
    where
        M: Middleware + 'static,
    {
        Ok(if let Some(signer) = signer {
            let signing_provider = make_signing_provider(provider, signer).await?;
            self.make_with_provider(signing_provider, locator)
        } else {
            self.make_with_provider(provider, locator)
        })
    }

    /// Construct a new instance of the associated trait using a provider.
    fn make_with_provider<M>(&self, provider: M, locator: &ContractLocator) -> Self::Output
    where
        M: Middleware + 'static;
}

async fn make_signing_provider<M: Middleware>(
    provider: M,
    signer: Signers,
) -> Result<SignerMiddleware<NonceManagerMiddleware<M>, Signers>, M::Error> {
    let provider_chain_id = provider.get_chainid().await?;
    let signer = ethers::signers::Signer::with_chain_id(signer, provider_chain_id.as_u64());

    let address = ethers::prelude::Signer::address(&signer);
    let provider = NonceManagerMiddleware::new(provider, address);

    let signing_provider = SignerMiddleware::new(provider, signer);
    Ok(signing_provider)
}
