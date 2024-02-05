use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use ethers::middleware::gas_oracle::{
    GasOracle, GasOracleMiddleware, ProviderOracle,
};
use ethers::prelude::{
    Http, JsonRpcClient, Middleware, NonceManagerMiddleware, Provider,
    SignerMiddleware, Ws, WsClientError,
};

use reqwest::Client;
use thiserror::Error;

use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, HyperlaneDomain,
};

use crate::{signers::Signers, ConnectionConf, RetryingProvider};

// This should be whatever the prometheus scrape interval is
const HTTP_CLIENT_TIMEOUT: Duration = Duration::from_secs(60);

/// An error when connecting to an ethereum provider.
#[derive(Error, Debug)]
pub enum EthereumProviderConnectionError {
    /// Underlying reqwest lib threw an error
    #[error(transparent)]
    ReqwestError(#[from] reqwest::Error),
    /// Underlying websocket library threw an error
    #[error(transparent)]
    WebsocketClientError(#[from] WsClientError),
}

impl From<EthereumProviderConnectionError> for ChainCommunicationError {
    fn from(e: EthereumProviderConnectionError) -> Self {
        ChainCommunicationError::from_other(e)
    }
}

/// A trait for dynamic trait creation with provider initialization.
#[async_trait]
pub trait BuildableWithProvider {
    /// The type that will be created.
    type Output;

    /// Construct a new instance of the associated trait using a connection
    /// config. This is the first step and will wrap the provider with
    /// metrics and a signer as needed.
    async fn build_with_connection_conf(
        &self,
        conn: &ConnectionConf,
        locator: &ContractLocator,
        signer: Option<Signers>,
    ) -> ChainResult<Self::Output> {
        Ok(match conn {
            ConnectionConf::Http { url } => {
                let http_client = Client::builder()
                    .timeout(HTTP_CLIENT_TIMEOUT)
                    .build()
                    .map_err(EthereumProviderConnectionError::from)?;
                let http_provider = Http::new_with_client(url.clone(), http_client);
                let retrying_http_provider = RetryingProvider::new(http_provider, None, None);
                self.build(retrying_http_provider, locator, signer)
                    .await?
            }
            ConnectionConf::Ws { url } => {
                let ws = Ws::connect(url)
                    .await
                    .map_err(EthereumProviderConnectionError::from)?;
                self.build(ws, locator, signer).await?
            }
        })
    }

    /// Create the provider, applying any middlewares (e.g. gas oracle, signer, metrics) as needed,
    /// and then create the associated trait.
    async fn build<P>(
        &self,
        client: P,
        locator: &ContractLocator,
        signer: Option<Signers>,
    ) -> ChainResult<Self::Output>
    where
        P: JsonRpcClient + 'static,
    {
        let provider = wrap_with_gas_oracle(Provider::new(client), locator.domain)?;
        Ok(self.build_with_signer(provider, locator, signer).await?)
    }

    /// Wrap the provider creation with a signing provider if signers were
    /// provided, and then create the associated trait.
    async fn build_with_signer<M>(
        &self,
        provider: M,
        locator: &ContractLocator,
        signer: Option<Signers>,
    ) -> ChainResult<Self::Output>
    where
        M: Middleware + 'static,
    {
        Ok(if let Some(signer) = signer {
            let signing_provider = wrap_with_signer(provider, signer)
                .await
                .map_err(ChainCommunicationError::from_other)?;
            self.build_with_provider(signing_provider, locator)
        } else {
            self.build_with_provider(provider, locator)
        }
        .await)
    }

    /// Construct a new instance of the associated trait using a provider.
    async fn build_with_provider<M>(&self, provider: M, locator: &ContractLocator) -> Self::Output
    where
        M: Middleware + 'static;
}

async fn wrap_with_signer<M: Middleware>(
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

/// Wrap the provider with a gas oracle middleware.
/// Polygon and Mumbai require using the Polygon gas oracle, see discussion here
/// https://github.com/foundry-rs/foundry/issues/1703.
/// Defaults to using the provider's gas oracle.
fn wrap_with_gas_oracle<M>(
    provider: M,
    _domain: &HyperlaneDomain,
) -> ChainResult<GasOracleMiddleware<Arc<M>, Box<dyn GasOracle>>>
where
    M: Middleware + 'static,
{
    let provider = Arc::new(provider);
    let gas_oracle: Box<dyn GasOracle> = Box::new(ProviderOracle::new(provider.clone()));
    Ok(GasOracleMiddleware::new(provider, gas_oracle))
}
