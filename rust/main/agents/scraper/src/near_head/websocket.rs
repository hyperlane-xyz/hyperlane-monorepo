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
    sync::Notify,
    time::{sleep, timeout},
};
use tracing::{info, warn};
use url::Url;

const RETRY_DELAY: Duration = Duration::from_secs(10);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

pub(super) async fn run(url: Option<Secret<Url>>, filter: Filter, wakeup: &Notify, domain: u32) {
    let Some(url) = url else { return };
    loop {
        // Do not log provider errors: they can contain the endpoint's API key.
        if subscribe(url.expose_secret(), &filter, wakeup, domain)
            .await
            .is_err()
        {
            warn!(
                domain,
                "Log WebSocket unavailable; polling continues, reconnecting in 10 seconds"
            );
        }
        sleep(RETRY_DELAY).await;
    }
}

async fn subscribe(url: &Url, filter: &Filter, wakeup: &Notify, domain: u32) -> Result<()> {
    let provider = Provider::new(timeout(CONNECT_TIMEOUT, Ws::connect(url.as_str())).await??);
    let mut logs = timeout(CONNECT_TIMEOUT, provider.subscribe_logs(filter)).await??;
    info!(domain, "Log WebSocket subscribed");
    // Reconcile anything missed before subscribing or while disconnected.
    wakeup.notify_one();
    while logs.next().await.is_some() {
        // Includes removed logs: the existing worker reconciles canonical ancestry.
        // Notify retains one permit, coalescing bursts and signals during indexing.
        wakeup.notify_one();
    }
    Err(eyre!("Log subscription closed"))
}

#[cfg(test)]
mod tests;
