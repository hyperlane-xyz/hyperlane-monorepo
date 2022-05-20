use std::sync::Arc;

use async_trait::async_trait;
use ethers::prelude::*;

use abacus_core::{ContractLocator, Signers};

use crate::Connection;

/// A trait for dynamic trait creation with provider initialization.
#[async_trait]
pub trait MakeableWithProvider {
    /// The type that will be created.
    type Output;

    /// Construct a new instance of the associated trait using a connection config.
    async fn make_with_connection(
        &self,
        conn: Connection,
        locator: &ContractLocator,
        signer: Option<Signers>,
    ) -> eyre::Result<Self::Output> {
        Ok(match conn {
            Connection::Http { url } => {
                let provider: crate::RetryingProvider<Http> = url.parse()?;
                let provider = Arc::new(Provider::new(provider));

                if let Some(signer) = signer {
                    let signing_provider = make_signing_provider(provider, signer).await?;
                    self.make_with_provider(signing_provider, locator)
                } else {
                    self.make_with_provider(provider, locator)
                }
            }
            Connection::Ws { url } => {
                let ws = Ws::connect(url).await?;
                let provider = Arc::new(Provider::new(ws));

                if let Some(signer) = signer {
                    let signing_provider = make_signing_provider(provider, signer).await?;
                    self.make_with_provider(signing_provider, locator)
                } else {
                    self.make_with_provider(provider, locator)
                }
            }
        })
    }

    /// Construct a new instance of the associated trait using a provider.
    fn make_with_provider<M: Middleware + 'static>(
        &self,
        provider: M,
        locator: &ContractLocator,
    ) -> Self::Output;
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
