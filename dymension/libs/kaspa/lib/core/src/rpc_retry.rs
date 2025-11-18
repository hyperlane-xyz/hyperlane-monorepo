use eyre::Result;
use kaspa_wallet_core::api::WalletApi;
use kaspa_wallet_core::wallet::Wallet;
use std::sync::Arc;
use std::time::Duration;
use tracing::{debug, error, info};

const MAX_RETRIES: u32 = 3;
const RETRY_DELAY_MS: u64 = 1000;

/// Executes an RPC call with automatic retry on failure.
///
/// If the RPC call fails (e.g., 500 error from disconnected server),
/// this will retry the call with exponential backoff.
///
/// Usage:
/// ```ignore
/// use corelib::rpc_retry::rpc_call_with_retry;
///
/// let result = rpc_call_with_retry(|| async {
///     rpc_client.get_block(hash, true).await
/// }).await?;
/// ```
pub async fn rpc_call_with_retry<F, Fut, T>(f: F) -> Result<T>
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = Result<T>>,
{
    for attempt in 1..=MAX_RETRIES {
        match f().await {
            Ok(result) => return Ok(result),
            Err(e) => {
                if attempt == MAX_RETRIES {
                    error!(
                        attempt = attempt,
                        max_retries = MAX_RETRIES,
                        error = ?e,
                        "kaspa rpc: max retries reached"
                    );
                    return Err(e);
                }

                info!(
                    attempt = attempt,
                    max_retries = MAX_RETRIES,
                    error = ?e,
                    "kaspa rpc: call error, retrying"
                );

                tokio::time::sleep(Duration::from_millis(RETRY_DELAY_MS * attempt as u64)).await;
                debug!(attempt = attempt + 1, "kaspa rpc: retrying");
            }
        }
    }

    unreachable!("loop should always return or error before reaching here")
}

/// Executes an RPC call with automatic reconnection on failure.
///
/// If the RPC call fails (e.g., 500 error from disconnected server),
/// this will disconnect and reconnect the wallet, then retry the call.
///
/// Usage:
/// ```ignore
/// use corelib::rpc_retry::rpc_call_with_reconnect;
///
/// let result = rpc_call_with_reconnect(&wallet, |w| {
///     Box::pin(async move { w.rpc_api().get_server_info().await })
/// }).await?;
/// ```
pub async fn rpc_call_with_reconnect<F, Fut, T>(wallet: &Arc<Wallet>, f: F) -> Result<T>
where
    F: Fn(Arc<Wallet>) -> Fut,
    Fut: std::future::Future<Output = Result<T>>,
{
    for attempt in 1..=MAX_RETRIES {
        let wallet_clone = wallet.clone();
        match f(wallet_clone).await {
            Ok(result) => return Ok(result),
            Err(e) => {
                if attempt == MAX_RETRIES {
                    error!(
                        attempt = attempt,
                        max_retries = MAX_RETRIES,
                        error = ?e,
                        "kaspa rpc: max retries reached"
                    );
                    return Err(e);
                }

                info!(
                    attempt = attempt,
                    max_retries = MAX_RETRIES,
                    error = ?e,
                    "kaspa rpc: call error, reconnecting"
                );

                if let Err(reconnect_err) = reconnect_wallet(wallet).await {
                    error!(
                        attempt = attempt,
                        error = ?reconnect_err,
                        "kaspa rpc: reconnect error"
                    );
                }

                tokio::time::sleep(Duration::from_millis(RETRY_DELAY_MS)).await;
                debug!(attempt = attempt + 1, "kaspa rpc: retrying");
            }
        }
    }

    unreachable!("loop should always return or error before reaching here")
}

async fn reconnect_wallet(wallet: &Arc<Wallet>) -> Result<()> {
    debug!("kaspa rpc: disconnecting");
    wallet.clone().disconnect().await?;

    debug!("kaspa rpc: connecting");
    let network_id = wallet.network_id()?;
    wallet.clone().connect(None, &network_id).await?;

    Ok(())
}
