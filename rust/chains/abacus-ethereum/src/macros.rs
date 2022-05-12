macro_rules! boxed_trait {
    (@finish $provider:expr, $abi:ident, $signer:ident, $($tail:tt)*) => {{
        if let Some(signer) = $signer {
            // If there's a provided signer, we want to manage every aspect
            // locally

            // First set the chain ID locally
            let provider_chain_id = $provider.get_chainid().await?;
            let signer = ethers::signers::Signer::with_chain_id(signer, provider_chain_id.as_u64());

            // Manage the nonce locally
            let address = ethers::prelude::Signer::address(&signer);
            let provider =
                ethers::middleware::nonce_manager::NonceManagerMiddleware::new($provider, address);

            // Manage signing locally
            let signing_provider = ethers::middleware::SignerMiddleware::new(provider, signer);

            Box::new(crate::$abi::new(signing_provider.into(), $($tail)*))
        } else {
            Box::new(crate::$abi::new($provider, $($tail)*))
        }
    }};
    (@ws $url:expr, $($tail:tt)*) => {{
        let ws = ethers::providers::Ws::connect($url).await?;
        let provider = Arc::new(ethers::providers::Provider::new(ws));
        boxed_trait!(@finish provider, $($tail)*)
    }};
    (@http $url:expr, $($tail:tt)*) => {{
        let provider: crate::RetryingProvider<ethers::providers::Http> = $url.parse()?;
        let provider = Arc::new(ethers::providers::Provider::new(provider));
        boxed_trait!(@finish provider, $($tail)*)
    }};
    ($name:ident, $abi:ident, $trait:ident, $($n:ident:$t:ty),*)  => {
        #[doc = "Cast a contract locator to a live contract handle"]
        pub async fn $name(conn: Connection, locator: &ContractLocator, signer: Option<Signers>, $($n:$t),*) -> eyre::Result<Box<dyn $trait>> {
            let b: Box<dyn $trait> = match conn {
                Connection::Http { url } => {
                    boxed_trait!(@http url, $abi, signer, locator, $($n),*)
                }
                Connection::Ws { url } => {
                    boxed_trait!(@ws url, $abi, signer, locator, $($n),*)
                }
            };
            Ok(b)
        }
    };
}
