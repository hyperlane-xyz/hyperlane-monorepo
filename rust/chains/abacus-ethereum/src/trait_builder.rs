use std::sync::Arc;

use ethers::prelude::*;

use abacus_core::Signers;

use crate::Connection;

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

pub(crate) trait MakeableWithProvider {
    type Output;

    fn make<M: Middleware + 'static>(self, provider: M) -> Self::Output;
}

pub(super) async fn build_trait<M: MakeableWithProvider>(
    conn: Connection,
    builder: M,
    signer: Option<Signers>,
) -> eyre::Result<M::Output> {
    Ok(match conn {
        Connection::Http { url } => {
            let provider: crate::RetryingProvider<Http> = url.parse()?;
            let provider = Arc::new(Provider::new(provider));

            if let Some(signer) = signer {
                let signing_provider = make_signing_provider(provider, signer).await?;
                builder.make(signing_provider)
            } else {
                builder.make(provider)
            }
        }
        Connection::Ws { url } => {
            let ws = Ws::connect(url).await?;
            let provider = Arc::new(Provider::new(ws));

            if let Some(signer) = signer {
                let signing_provider = make_signing_provider(provider, signer).await?;
                builder.make(signing_provider)
            } else {
                builder.make(provider)
            }
        }
    })
}
