use std::{collections::HashMap, time::Duration};

use eyre::{bail, Context, Result};
use futures_util::{SinkExt, StreamExt};
use hyperlane_base::{
    broadcast::BroadcastMpscSender,
    db::{HyperlaneDb, HyperlaneRocksDB},
};
use hyperlane_core::{HyperlaneDomain, HyperlaneMessage, H256, H512};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::{
    sync::oneshot,
    time::{sleep, timeout, Instant},
};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{debug, info, warn};

pub(crate) struct ScraperProxyMessageIndexer {
    url: String,
    origins: HashMap<u32, ScraperProxyMessageIndexerOrigin>,
    reconnect_delay: Duration,
    stale_timeout: Duration,
}

#[derive(Clone)]
pub(crate) struct ScraperProxyMessageIndexerOrigin {
    pub(crate) domain: HyperlaneDomain,
    pub(crate) db: HyperlaneRocksDB,
    pub(crate) tx_id_broadcaster: Option<BroadcastMpscSender<H512>>,
}

impl ScraperProxyMessageIndexer {
    pub(crate) fn new(
        url: String,
        origins: Vec<ScraperProxyMessageIndexerOrigin>,
        reconnect_delay: Duration,
        stale_timeout: Duration,
    ) -> Self {
        Self {
            url,
            origins: origins
                .into_iter()
                .map(|origin| (origin.domain.id(), origin))
                .collect(),
            reconnect_delay,
            stale_timeout,
        }
    }

    pub(crate) async fn run(self, mut connected: Option<oneshot::Sender<()>>) -> Result<()> {
        info!(
            origin_count = self.origins.len(),
            url = self.url,
            reconnect_delay_ms = self.reconnect_delay.as_millis(),
            stale_timeout_ms = self.stale_timeout.as_millis(),
            "[WS] starting global scraper-proxy message indexer"
        );

        let mut last_progress = Instant::now();
        loop {
            match self.run_once(&mut last_progress, &mut connected).await {
                Ok(()) => {}
                Err(err) => {
                    warn!(
                        origin_count = self.origins.len(),
                        error = %err,
                        "[WS] scraper-proxy message indexer connection failed"
                    );
                }
            }

            let stale_for = last_progress.elapsed();
            if stale_for >= self.stale_timeout {
                bail!(
                    "[WS] scraper-proxy message indexer stale for {}s",
                    stale_for.as_secs()
                );
            }

            info!(
                origin_count = self.origins.len(),
                reconnect_delay_ms = self.reconnect_delay.as_millis(),
                stale_for_ms = stale_for.as_millis(),
                "[WS] reconnecting scraper-proxy message indexer"
            );
            sleep(self.reconnect_delay).await;
        }
    }

    async fn run_once(
        &self,
        last_progress: &mut Instant,
        connected: &mut Option<oneshot::Sender<()>>,
    ) -> Result<()> {
        let (mut ws, _) = connect_async(&self.url)
            .await
            .with_context(|| format!("failed to connect to {}", self.url))?;
        *last_progress = Instant::now();
        info!(
            origin_count = self.origins.len(),
            url = self.url,
            "[WS] connected scraper-proxy message indexer websocket"
        );

        ws.send(Message::Text(
            json!({ "type": "subscribe_latest" }).to_string(),
        ))
        .await
        .context("[WS] failed to subscribe to latest scraper-proxy messages")?;
        info!(
            origin_count = self.origins.len(),
            "[WS] subscribed scraper-proxy latest message stream"
        );
        if let Some(connected) = connected.take() {
            let _ = connected.send(());
        }

        loop {
            let next = timeout(self.stale_timeout, ws.next())
                .await
                .context("[WS] scraper-proxy websocket stale")?;
            let Some(next) = next else {
                bail!("[WS] scraper-proxy websocket stream ended");
            };
            *last_progress = Instant::now();

            let message = next.context("[WS] scraper-proxy websocket read failed")?;
            match message {
                Message::Text(text) => self.handle_text(&text).await?,
                Message::Close(frame) => bail!("[WS] scraper-proxy websocket closed: {:?}", frame),
                Message::Ping(_) | Message::Pong(_) | Message::Binary(_) | Message::Frame(_) => {}
            }
        }
    }

    async fn handle_text(&self, text: &str) -> Result<()> {
        let event: Value =
            serde_json::from_str(text).context("[WS] invalid scraper-proxy websocket json")?;
        let event_type = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let message_id = event
            .get("message")
            .and_then(|message| message.get("msg_id"))
            .and_then(Value::as_str);
        let operation = event.get("operation").and_then(Value::as_str);
        info!(
            event_type,
            message_id,
            operation,
            payload_bytes = text.len(),
            "[WS] received scraper-proxy websocket message"
        );

        if event_type != "latest_message" {
            debug!(event_type, "[WS] ignoring scraper-proxy event");
            return Ok(());
        }

        if operation != Some("INSERT") {
            debug!(
                event_type,
                operation, message_id, "[WS] ignoring scraper-proxy non-insert latest message"
            );
            return Ok(());
        }

        let Some(message) = event.get("message") else {
            debug!(
                event_type,
                "[WS] ignoring scraper-proxy message event without payload"
            );
            return Ok(());
        };

        if !message.is_object() {
            debug!(
                event_type,
                "[WS] ignoring scraper-proxy message event with non-object payload"
            );
            return Ok(());
        }

        let row: ScraperProxyMessageRow = serde_json::from_value(message.clone())
            .with_context(|| format!("[WS] invalid scraper-proxy message: {message}"))?;

        let Some(origin) = self.origins.get(&row.origin_domain_id) else {
            debug!(
                origin_domain_id = row.origin_domain_id,
                message_id = row.msg_id.as_deref(),
                "[WS] ignoring scraper-proxy message for unconfigured origin"
            );
            return Ok(());
        };

        let hyperlane_message = row.hyperlane_message()?;
        if let Some(expected_id) = row.msg_id.as_deref() {
            let expected_id = parse_h256(expected_id).context("invalid scraper message id")?;
            if expected_id != hyperlane_message.id() {
                warn!(
                    chain = origin.domain.name(),
                    nonce = hyperlane_message.nonce,
                    expected = ?expected_id,
                    actual = ?hyperlane_message.id(),
                    "[WS] skipping scraper-proxy message with mismatched id"
                );
                return Ok(());
            }
        }

        let stored = origin
            .db
            .store_message(&hyperlane_message, row.origin_block_height)
            .context("[WS] failed to store scraper-proxy message")?;

        let tx_hash = parse_h512(&row.origin_tx_hash).context("invalid origin tx hash")?;
        origin
            .db
            .store_dispatched_tx_hash_by_message_id(&hyperlane_message.id(), &tx_hash)
            .context("[WS] failed to store scraper-proxy message tx hash")?;

        if let Some(broadcaster) = origin.tx_id_broadcaster.as_ref() {
            broadcaster
                .send(tx_hash)
                .await
                .context("[WS] failed to broadcast scraper-proxy message tx hash")?;
        }

        info!(
            chain = origin.domain.name(),
            nonce = hyperlane_message.nonce,
            message_id = ?hyperlane_message.id(),
            tx_hash = ?tx_hash,
            origin_block_height = row.origin_block_height,
            stored,
            "[WS] indexed scraper-proxy message"
        );

        Ok(())
    }
}

#[derive(Debug, Deserialize)]
struct ScraperProxyMessageRow {
    msg_id: Option<String>,
    nonce: u32,
    origin_domain_id: u32,
    destination_domain_id: u32,
    sender: String,
    recipient: String,
    message_body: String,
    #[serde(deserialize_with = "deserialize_u64")]
    origin_block_height: u64,
    origin_tx_hash: String,
}

impl ScraperProxyMessageRow {
    fn hyperlane_message(&self) -> Result<HyperlaneMessage> {
        Ok(HyperlaneMessage {
            version: 3,
            nonce: self.nonce,
            origin: self.origin_domain_id,
            sender: parse_h256_address(&self.sender).context("invalid sender")?,
            destination: self.destination_domain_id,
            recipient: parse_h256_address(&self.recipient).context("invalid recipient")?,
            body: parse_hex_bytes(&self.message_body).context("invalid message body")?,
        })
    }
}

fn parse_h256(value: &str) -> Result<H256> {
    let bytes = parse_hex_bytes(value)?;
    if bytes.len() != 32 {
        bail!("expected 32 bytes, got {}", bytes.len());
    }
    Ok(H256::from_slice(&bytes))
}

fn parse_h256_address(value: &str) -> Result<H256> {
    let bytes = parse_hex_bytes(value)?;
    if bytes.len() > 32 {
        bail!("expected at most 32 bytes, got {}", bytes.len());
    }

    let mut padded = [0u8; 32];
    let start = 32usize.saturating_sub(bytes.len());
    padded[start..].copy_from_slice(&bytes);
    Ok(H256::from_slice(&padded))
}

fn parse_h512(value: &str) -> Result<H512> {
    let bytes = parse_hex_bytes(value)?;
    if bytes.len() > 64 {
        bail!("expected at most 64 bytes, got {}", bytes.len());
    }

    let mut padded = [0u8; 64];
    let start = 64usize.saturating_sub(bytes.len());
    padded[start..].copy_from_slice(&bytes);
    Ok(H512::from_slice(&padded))
}

fn parse_hex_bytes(value: &str) -> Result<Vec<u8>> {
    let hex = value
        .strip_prefix("\\x")
        .or_else(|| value.strip_prefix("0x"))
        .unwrap_or(value);
    Ok(hex::decode(hex)?)
}

fn deserialize_u64<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    match value {
        Value::Number(number) => number
            .as_u64()
            .ok_or_else(|| serde::de::Error::custom("expected unsigned integer")),
        Value::String(string) => string
            .parse()
            .map_err(|err| serde::de::Error::custom(format!("invalid u64: {err}"))),
        _ => Err(serde::de::Error::custom("expected u64 or string")),
    }
}
