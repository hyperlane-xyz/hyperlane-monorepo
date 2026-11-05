//! Optional wake-up hints. HTTP range reads and persisted progress remain authoritative.
use std::time::Duration;

use ethers::{
    providers::{Middleware, Provider, Ws},
    types::Filter,
};
use eyre::{eyre, Result};
use futures::StreamExt;
use redact::Secret;
use tokio::{
    sync::{mpsc, Notify},
    time::{sleep, timeout},
};
use tracing::{info, warn};
use url::Url;

use super::source::Header;

const RETRY_DELAY: Duration = Duration::from_secs(10);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

pub(super) async fn run(
    url: Option<Secret<Url>>,
    filter: Filter,
    wakeup: &Notify,
    heads_tx: &mpsc::Sender<Header>,
    domain: u32,
) {
    let Some(url) = url else { return };
    loop {
        // Do not log provider errors: they can contain the endpoint's API key.
        if subscribe(url.expose_secret(), &filter, wakeup, heads_tx, domain)
            .await
            .is_err()
        {
            warn!(
                domain,
                "Event/head WebSocket unavailable; polling continues, reconnecting in 10 seconds"
            );
        }
        sleep(RETRY_DELAY).await;
    }
}

async fn subscribe(
    url: &Url,
    filter: &Filter,
    wakeup: &Notify,
    heads_tx: &mpsc::Sender<Header>,
    domain: u32,
) -> Result<()> {
    let provider = Provider::new(timeout(CONNECT_TIMEOUT, Ws::connect(url.as_str())).await??);
    let mut logs = timeout(CONNECT_TIMEOUT, provider.subscribe_logs(filter)).await??;
    let mut heads = timeout(CONNECT_TIMEOUT, provider.subscribe_blocks()).await??;
    info!(domain, "Event/head WebSocket subscribed");
    // Reconcile anything missed before subscribing or while disconnected.
    wakeup.notify_one();
    loop {
        tokio::select! {
            log = logs.next() => {
                log.ok_or_else(|| eyre!("Log subscription closed"))?;
                // Includes removed logs; the worker reconciles canonical ancestry.
                wakeup.notify_one();
            }
            head = heads.next() => {
                let head = head.ok_or_else(|| eyre!("Head subscription closed"))?;
                let header = Header {
                    height: head.number.ok_or_else(|| eyre!("Missing head number"))?.as_u64(),
                    hash: head.hash.ok_or_else(|| eyre!("Missing head hash"))?,
                    parent: head.parent_hash,
                    timestamp: head.timestamp.as_u64(),
                };
                match heads_tx.try_send(header) {
                    Ok(()) => {},
                    // Keep logs flowing during catch-up. A later gap is handled by polling.
                    Err(mpsc::error::TrySendError::Full(_)) => {},
                    Err(mpsc::error::TrySendError::Closed(_)) => return Err(eyre!("Head consumer closed")),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests;
