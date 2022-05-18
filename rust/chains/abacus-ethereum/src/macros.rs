/// Dispatches a transaction, logs the tx id, and returns the result
#[macro_export]
macro_rules! report_tx {
    ($tx:expr) => {{

        // "0x..."
        let data = format!("0x{}", hex::encode(&$tx.tx.data().map(|b| b.to_vec()).unwrap_or_default()));

        let to = $tx.tx.to().cloned().unwrap_or_else(|| ethers::types::NameOrAddress::Address(Default::default()));

        tracing::info!(
            to = ?to,
            data = %data,
            "Dispatching transaction"
        );
        // We can set the gas higher here!
        let dispatch_fut = $tx.send();
        let dispatched = dispatch_fut.await?;

        let tx_hash: ethers::core::types::H256 = *dispatched;

        tracing::info!(
            to = ?to,
            data = %data,
            tx_hash = ?tx_hash,
            "Dispatched tx"
        );


        let wrapped_tx_submission = tokio::time::timeout(std::time::Duration::from_secs(300), dispatched);

        match wrapped_tx_submission.await {
            Ok(tx_submission) => {
                match tx_submission {
                    Ok(Some(receipt)) => {
                        tracing::info!(
                            tx_hash = ?tx_hash,
                            "confirmed transaction"
                        );

                        receipt
                    }
                    // ethers-rs will return None if it can no longer poll for the tx in the mempool
                    Ok(None) => {
                        return Err(abacus_core::ChainCommunicationError::DroppedError(tx_hash))
                    }
                    // Pass through this error
                    Err(x) => {
                        tracing::error!(
                            tx_hash = ?tx_hash,
                            error = ?x,
                            "encountered error when waiting for receipt",
                        );
                        return Err(x.into())
                    }
                }
            }
            Err(x) => {
                tracing::error!(
                    tx_hash = ?tx_hash,
                    error = ?x,
                    "waiting for receipt timed out",
                );
                return Err(abacus_core::ChainCommunicationError::TransactionTimeout())
            }
        }
    }};
}

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
