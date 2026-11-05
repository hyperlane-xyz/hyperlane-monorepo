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
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};
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
    let logs = timeout(
        CONNECT_TIMEOUT,
        subscription(&mut socket, 1, json!(["logs", filter]), None, wanted),
    )
    .await??;
    let heads = timeout(
        CONNECT_TIMEOUT,
        subscription(&mut socket, 2, json!(["newHeads"]), Some(&logs), wanted),
    )
    .await??;
    let mut polled_height = *polled_head.borrow_and_update();
    let mut received_height = polled_height;
    let mut lagging = false;
    let stalled = sleep(HEAD_STALL_TIMEOUT);
    tokio::pin!(stalled);
    info!(domain, "Event/head WebSocket subscribed");
    // Reconcile anything missed before subscribing or while disconnected.
    wakeup.notify_one();
    loop {
        tokio::select! {
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
                let params = &notification["params"];
                if params["subscription"] == logs {
                    let log: Log = serde_json::from_value(params["result"].clone())?;
                    if let Some(height) = log.block_number {
                        wanted.fetch_max(height.as_u64(), Ordering::Relaxed);
                    }
                    // Includes removed logs; the worker reconciles canonical ancestry.
                    wakeup.notify_one();
                } else if params["subscription"] == heads {
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

// Retain log heights received during the second handshake, so the connect wake
// can retry if HTTP is still behind when both subscriptions are established.
async fn subscription(
    socket: &mut WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>,
    id: u64,
    params: Value,
    logs: Option<&str>,
    wanted: &AtomicU64,
) -> Result<String> {
    socket
        .send(Message::Text(
            json!({
                "jsonrpc": "2.0", "id": id, "method": "eth_subscribe", "params": params
            })
            .to_string()
            .into(),
        ))
        .await?;
    loop {
        let message = socket
            .next()
            .await
            .ok_or_else(|| eyre!("WebSocket closed"))??;
        match message {
            Message::Text(text) => {
                let response: Value = serde_json::from_str(&text)?;
                if response["id"] == id {
                    return response["result"]
                        .as_str()
                        .map(str::to_owned)
                        .ok_or_else(|| eyre!("WebSocket subscription rejected"));
                }
                if logs.is_some_and(|logs| response["params"]["subscription"] == logs) {
                    let log: Log = serde_json::from_value(response["params"]["result"].clone())?;
                    if let Some(height) = log.block_number {
                        wanted.fetch_max(height.as_u64(), Ordering::Relaxed);
                    }
                }
            }
            Message::Ping(payload) => socket.send(Message::Pong(payload)).await?,
            Message::Close(_) => return Err(eyre!("WebSocket closed")),
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests;
