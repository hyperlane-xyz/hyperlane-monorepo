//! Optional wake-up hints. HTTP range reads and persisted progress remain authoritative.
use std::{
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

use ethers::types::{Block, Filter, Log, H256};
use eyre::{eyre, Result};
use futures::{SinkExt, StreamExt};
use redact::Secret;
use serde_json::{json, Value};
use tokio::{
    sync::{mpsc, watch, Notify},
    time::{sleep, timeout},
};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{info, warn};
use url::Url;

use super::source::Header;

const RETRY_DELAY: Duration = Duration::from_secs(10);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const HEAD_STALL_TIMEOUT: Duration = Duration::from_secs(30);

pub(super) async fn run(
    url: Option<Secret<Url>>,
    filter: Filter,
    wakeup: &Notify,
    wanted: &AtomicU64,
    heads_tx: &mpsc::Sender<Header>,
    mut polled_head: watch::Receiver<u64>,
    domain: u32,
) {
    let Some(url) = url else { return };
    loop {
        // Do not log provider errors: they can contain the endpoint's API key.
        if subscribe(
            url.expose_secret(),
            &filter,
            wakeup,
            wanted,
            heads_tx,
            &mut polled_head,
            domain,
        )
        .await
        .is_err()
        {
            warn!(
                domain,
                "Event/head WebSocket unavailable; polling continues, reconnecting"
            );
        }
        // Spread provider-wide reconnects across domains.
        let jitter = u64::from(domain).wrapping_mul(0x9E37_79B9_7F4A_7C15) % 2_000;
        sleep(RETRY_DELAY.saturating_add(Duration::from_millis(jitter))).await;
    }
}

async fn subscribe(
    url: &Url,
    filter: &Filter,
    wakeup: &Notify,
    wanted: &AtomicU64,
    heads_tx: &mpsc::Sender<Header>,
    polled_head: &mut watch::Receiver<u64>,
    domain: u32,
) -> Result<()> {
    // Own the transport directly: dropping this future closes the socket even if
    // an eth_subscribe request never replies. Ethers detaches its pending requests.
    let (mut socket, _) = timeout(CONNECT_TIMEOUT, connect_async(url.as_str())).await??;
    for (id, params) in [(1, json!(["logs", filter])), (2, json!(["newHeads"]))] {
        timeout(
            CONNECT_TIMEOUT,
            socket.send(Message::Text(
                json!({
                    "jsonrpc": "2.0", "id": id, "method": "eth_subscribe", "params": params
                })
                .to_string()
                .into(),
            )),
        )
        .await??;
    }
    let (mut logs, mut heads) = (None, None);
    let subscribing = sleep(CONNECT_TIMEOUT);
    tokio::pin!(subscribing);
    let mut polled_height = *polled_head.borrow_and_update();
    let mut received_height = polled_height;
    let mut lagging = false;
    let stalled = sleep(HEAD_STALL_TIMEOUT);
    tokio::pin!(stalled);
    loop {
        tokio::select! {
            _ = &mut subscribing, if logs.is_none() || heads.is_none() => {
                return Err(eyre!("WebSocket subscription timed out"));
            }
            _ = &mut stalled, if lagging => {
                return Err(eyre!("Head subscription stalled behind polling"));
            }
            changed = polled_head.changed() => {
                changed.map_err(|_| eyre!("Polling observer closed"))?;
                polled_height = *polled_head.borrow_and_update();
            }
            message = socket.next() => {
                let message = message.ok_or_else(|| eyre!("WebSocket closed"))??;
                if let Message::Ping(payload) = message {
                    timeout(CONNECT_TIMEOUT, socket.send(Message::Pong(payload))).await??;
                    continue;
                }
                if matches!(message, Message::Close(_)) {
                    return Err(eyre!("WebSocket closed"));
                }
                let Message::Text(text) = message else { continue };
                let notification: Value = serde_json::from_str(&text)?;
                if let Some(id) = notification["id"].as_u64() {
                    let subscription = notification["result"].as_str()
                        .ok_or_else(|| eyre!("WebSocket subscription rejected"))?.to_owned();
                    match id {
                        1 => logs = Some(subscription),
                        2 => heads = Some(subscription),
                        _ => return Err(eyre!("Unexpected subscription response")),
                    }
                    if logs.is_some() && heads.is_some() {
                        info!(domain, "Event/head WebSocket subscribed");
                        wakeup.notify_one(); // Reconcile missed events after reconnect.
                    }
                    continue;
                }
                let params = &notification["params"];
                let Some(subscription) = params["subscription"].as_str() else { continue };
                if Some(subscription) == logs.as_deref() {
                    let log: Log = serde_json::from_value(params["result"].clone())?;
                    if let Some(height) = log.block_number {
                        wanted.fetch_max(height.as_u64(), Ordering::Relaxed);
                    }
                    // Includes removed logs; the worker reconciles canonical ancestry.
                    wakeup.notify_one();
                } else if Some(subscription) == heads.as_deref() {
                    let head: Block<H256> = serde_json::from_value(params["result"].clone())?;
                    let header = Header {
                        height: head.number.ok_or_else(|| eyre!("Missing head number"))?.as_u64(),
                        hash: head.hash.ok_or_else(|| eyre!("Missing head hash"))?,
                        parent: head.parent_hash,
                        timestamp: head.timestamp.as_u64(),
                    };
                    if header.height > received_height {
                        lagging = false;
                    }
                    received_height = header.height;
                    match heads_tx.try_send(header) {
                        Ok(()) => {},
                        // Keep logs flowing during catch-up. A later gap is handled by polling.
                        Err(mpsc::error::TrySendError::Full(_)) => {},
                        Err(mpsc::error::TrySendError::Closed(_)) => return Err(eyre!("Head consumer closed")),
                    }
                }
            }
        }
        let behind = polled_height > received_height;
        if behind && !lagging {
            // Allow delivery skew, but repeated polls/logs cannot postpone recovery.
            stalled.set(sleep(HEAD_STALL_TIMEOUT));
        }
        lagging = behind;
    }
}

#[cfg(test)]
mod tests;
