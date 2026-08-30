//! Shadow validation of relayer inputs streamed by scraper-proxy.

use std::{collections::HashMap, time::Duration};

use eyre::{bail, Context, ContextCompat, Result};
use futures_util::{SinkExt, StreamExt};
use hyperlane_base::{
    scraper_websocket::{
        EventMessage, ServerMessage, StringOrNumber, SubscribeMessage, SubscribeStream,
    },
    CoreMetrics,
};
use hyperlane_core::{bytes_to_address, H256};
use prometheus::{IntCounterVec, IntGaugeVec};
use serde::Deserialize;
use tokio::time::{sleep, timeout, Instant};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{info, warn};
use url::Url;

const DISPATCH_EVENT_TYPE: &str = "dispatch";
const MERKLE_EVENT_TYPE: &str = "merkle_tree_insertion";
const READ_TIMEOUT: Duration = Duration::from_secs(75);
const RETRY_DELAY: Duration = Duration::from_secs(5);

#[derive(Clone, Debug)]
pub(crate) struct ScraperSource {
    chain: String,
    domain: u32,
    mailbox: H256,
    merkle_tree_hook: H256,
}

impl ScraperSource {
    pub(crate) fn new(chain: String, domain: u32, mailbox: H256, merkle_tree_hook: H256) -> Self {
        Self {
            chain,
            domain,
            mailbox,
            merkle_tree_hook,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum EventKind {
    Dispatch,
    MerkleTreeInsertion,
}

impl EventKind {
    fn label(self) -> &'static str {
        match self {
            Self::Dispatch => DISPATCH_EVENT_TYPE,
            Self::MerkleTreeInsertion => MERKLE_EVENT_TYPE,
        }
    }
}

#[derive(Debug, Eq, PartialEq)]
enum SequenceResult {
    Accepted,
    Duplicate,
}

#[derive(Debug, thiserror::Error)]
#[error("Scraper stream gap: expected sequence {expected}, received {received}")]
struct StreamGap {
    expected: u32,
    received: u32,
}

#[derive(Debug, Default)]
struct StreamState {
    next_sequences: HashMap<(u32, EventKind), u32>,
}

impl StreamState {
    fn validate(
        &mut self,
        event: EventMessage<serde_json::Value>,
        sources: &HashMap<u32, ScraperSource>,
    ) -> Result<(EventKind, SequenceResult)> {
        let source = sources
            .get(&event.domain)
            .with_context(|| format!("Unexpected scraper event domain {}", event.domain))?;
        let sequence = event
            .sequence
            .as_deref()
            .context("Sequenced scraper event omitted sequence")?
            .parse::<u32>()
            .context("Invalid scraper event sequence")?;

        let kind = match event.event_type.as_str() {
            DISPATCH_EVENT_TYPE => {
                let data: DispatchEventData =
                    serde_json::from_value(event.data).context("Invalid dispatch event payload")?;
                if data.origin_domain != event.domain {
                    bail!("Dispatch payload domain does not match event envelope");
                }
                if parse_address(&data.origin_mailbox)? != source.mailbox {
                    bail!("Dispatch event mailbox does not match configured mailbox");
                }
                if data.nonce.as_u32("dispatch nonce")? != sequence {
                    bail!("Dispatch event nonce does not match stream sequence");
                }
                EventKind::Dispatch
            }
            MERKLE_EVENT_TYPE => {
                let data: MerkleEventData = serde_json::from_value(event.data)
                    .context("Invalid Merkle tree insertion payload")?;
                if data.domain != event.domain {
                    bail!("Merkle payload domain does not match event envelope");
                }
                if parse_address(&data.merkle_tree_hook)? != source.merkle_tree_hook {
                    bail!("Merkle event hook does not match configured hook");
                }
                if data.leaf_index.as_u32("Merkle leaf index")? != sequence {
                    bail!("Merkle leaf index does not match stream sequence");
                }
                EventKind::MerkleTreeInsertion
            }
            event_type => bail!("Unexpected scraper event type {event_type}"),
        };

        let key = (event.domain, kind);
        let result = match self.next_sequences.get_mut(&key) {
            None => {
                self.next_sequences.insert(
                    key,
                    sequence
                        .checked_add(1)
                        .context("Scraper event sequence exhausted")?,
                );
                SequenceResult::Accepted
            }
            Some(next_sequence) if sequence < *next_sequence => SequenceResult::Duplicate,
            Some(next_sequence) if sequence == *next_sequence => {
                *next_sequence = next_sequence
                    .checked_add(1)
                    .context("Scraper event sequence exhausted")?;
                SequenceResult::Accepted
            }
            Some(next_sequence) => {
                return Err(StreamGap {
                    expected: *next_sequence,
                    received: sequence,
                }
                .into())
            }
        };
        Ok((kind, result))
    }
}

/// One process-wide, read-only scraper stream monitor.
pub(crate) struct ScraperWebSocketMonitor {
    active: IntGaugeVec,
    events: IntCounterVec,
    sources: HashMap<u32, ScraperSource>,
    url: Url,
}

impl ScraperWebSocketMonitor {
    pub(crate) fn new(
        url: Url,
        sources: Vec<ScraperSource>,
        metrics: &CoreMetrics,
    ) -> Result<Self> {
        let active = metrics.new_int_gauge(
            "relayer_scraper_websocket_active",
            "Whether the relayer scraper-proxy shadow stream is active",
            &["chain"],
        )?;
        let events = metrics.new_int_counter(
            "relayer_scraper_websocket_events",
            "Scraper-proxy shadow events validated by the relayer",
            &["chain", "event_type", "result"],
        )?;
        let sources = sources
            .into_iter()
            .map(|source| (source.domain, source))
            .collect::<HashMap<_, _>>();
        for source in sources.values() {
            active.with_label_values(&[&source.chain]).set(0);
        }
        Ok(Self {
            active,
            events,
            sources,
            url,
        })
    }

    pub(crate) async fn run(self) {
        loop {
            self.set_active(false);
            match self.stream().await {
                Ok(()) => warn!("Relayer scraper-proxy shadow stream closed; reconnecting"),
                Err(err) => warn!(
                    ?err,
                    "Relayer scraper-proxy shadow stream failed; reconnecting"
                ),
            }
            self.set_active(false);
            sleep(RETRY_DELAY).await;
        }
    }

    async fn stream(&self) -> Result<()> {
        let (mut socket, _) = timeout(READ_TIMEOUT, connect_async(self.url.as_str()))
            .await
            .context("Connecting to relayer scraper-proxy WebSocket timed out")?
            .context("Connecting to relayer scraper-proxy WebSocket")?;
        let mut subscribed = false;
        let mut state = StreamState::default();
        let read_deadline = sleep(READ_TIMEOUT);
        tokio::pin!(read_deadline);

        while let Some(message) = tokio::select! {
            _ = &mut read_deadline => bail!("Relayer scraper-proxy WebSocket heartbeat timed out"),
            message = socket.next() => message,
        } {
            let next_read_deadline = Instant::now()
                .checked_add(READ_TIMEOUT)
                .expect("read timeout cannot exceed Instant range");
            read_deadline.as_mut().reset(next_read_deadline);
            match message.context("Reading relayer scraper-proxy WebSocket message")? {
                Message::Text(text) => {
                    let message: ServerMessage<serde_json::Value> = serde_json::from_str(&text)
                        .context("Parsing relayer scraper-proxy WebSocket message")?;
                    match message {
                        ServerMessage::Ready => {
                            if subscribed {
                                bail!("Received duplicate scraper-proxy ready message");
                            }
                            socket
                                .send(Message::Text(self.subscription()?))
                                .await
                                .context("Subscribing to relayer scraper-proxy streams")?;
                            subscribed = true;
                        }
                        ServerMessage::Subscribed => {
                            if !subscribed {
                                bail!("Received subscribed before ready");
                            }
                            self.set_active(true);
                            info!("Relayer scraper-proxy shadow streams active");
                        }
                        ServerMessage::Event(event) => {
                            let domain = event.domain;
                            let event_type = event_label(&event.event_type);
                            match state.validate(event, &self.sources) {
                                Ok((kind, SequenceResult::Accepted)) => {
                                    self.record(domain, kind.label(), "accepted")
                                }
                                Ok((kind, SequenceResult::Duplicate)) => {
                                    self.record(domain, kind.label(), "duplicate")
                                }
                                Err(err) => {
                                    let result = if err.downcast_ref::<StreamGap>().is_some() {
                                        "gap"
                                    } else {
                                        "invalid"
                                    };
                                    self.record(domain, event_type, result);
                                    return Err(err);
                                }
                            }
                        }
                        ServerMessage::CaughtUp { .. } => {
                            bail!("Live-only relayer shadow stream received caught-up marker")
                        }
                        ServerMessage::Error { error } => {
                            bail!("Scraper-proxy rejected relayer shadow stream: {error}")
                        }
                        ServerMessage::Other => {}
                    }
                }
                Message::Ping(payload) => socket
                    .send(Message::Pong(payload))
                    .await
                    .context("Responding to relayer scraper-proxy heartbeat")?,
                Message::Close(frame) => {
                    bail!("Relayer scraper-proxy WebSocket closed: {frame:?}")
                }
                Message::Binary(_) | Message::Pong(_) | Message::Frame(_) => {}
            }
        }
        Ok(())
    }

    fn subscription(&self) -> Result<String> {
        subscription(self.sources.keys().copied().collect())
    }

    fn set_active(&self, active: bool) {
        let value = i64::from(active);
        for source in self.sources.values() {
            self.active.with_label_values(&[&source.chain]).set(value);
        }
    }

    fn record(&self, domain: u32, event_type: &str, result: &str) {
        let chain = self
            .sources
            .get(&domain)
            .map(|source| source.chain.as_str())
            .unwrap_or("unknown");
        self.events
            .with_label_values(&[chain, event_type, result])
            .inc();
    }
}

fn subscription(mut domains: Vec<u32>) -> Result<String> {
    domains.sort_unstable();
    serde_json::to_string(&SubscribeMessage {
        streams: vec![
            SubscribeStream {
                cursors: None,
                domains: Some(domains.clone()),
                event_type: DISPATCH_EVENT_TYPE,
            },
            SubscribeStream {
                cursors: None,
                domains: Some(domains),
                event_type: MERKLE_EVENT_TYPE,
            },
        ],
        message_type: "subscribe",
    })
    .context("Serializing relayer scraper-proxy subscription")
}

#[derive(Debug, Deserialize)]
struct DispatchEventData {
    nonce: StringOrNumber,
    origin_domain: u32,
    origin_mailbox: String,
}

#[derive(Debug, Deserialize)]
struct MerkleEventData {
    domain: u32,
    leaf_index: StringOrNumber,
    merkle_tree_hook: String,
}

fn parse_address(value: &str) -> Result<H256> {
    let value = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("\\x"))
        .unwrap_or(value);
    bytes_to_address(hex::decode(value).context("Invalid hexadecimal scraper event address")?)
        .context("Invalid scraper event address")
}

fn event_label(event_type: &str) -> &'static str {
    match event_type {
        DISPATCH_EVENT_TYPE => DISPATCH_EVENT_TYPE,
        MERKLE_EVENT_TYPE => MERKLE_EVENT_TYPE,
        _ => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sources() -> HashMap<u32, ScraperSource> {
        HashMap::from([(
            5,
            ScraperSource::new(
                "test".to_owned(),
                5,
                H256::from_low_u64_be(1),
                H256::from_low_u64_be(2),
            ),
        )])
    }

    fn event(
        event_type: &str,
        sequence: u32,
        data: serde_json::Value,
    ) -> EventMessage<serde_json::Value> {
        EventMessage {
            data,
            domain: 5,
            event_type: event_type.to_owned(),
            sequence: Some(sequence.to_string()),
        }
    }

    #[test]
    fn accepts_contiguous_dispatch_and_rejects_gap() {
        let sources = sources();
        let mut state = StreamState::default();
        let data = |nonce| {
            serde_json::json!({
                "nonce": nonce,
                "origin_domain": 5,
                "origin_mailbox": format!("{:#x}", H256::from_low_u64_be(1)),
            })
        };

        assert_eq!(
            state
                .validate(event(DISPATCH_EVENT_TYPE, 7, data(7)), &sources)
                .expect("first event"),
            (EventKind::Dispatch, SequenceResult::Accepted)
        );
        assert_eq!(
            state
                .validate(event(DISPATCH_EVENT_TYPE, 7, data(7)), &sources)
                .expect("duplicate event"),
            (EventKind::Dispatch, SequenceResult::Duplicate)
        );
        assert!(state
            .validate(event(DISPATCH_EVENT_TYPE, 9, data(9)), &sources)
            .expect_err("gap must reject")
            .to_string()
            .contains("expected sequence 8"));
    }

    #[test]
    fn rejects_wrong_dispatch_mailbox() {
        let error = StreamState::default()
            .validate(
                event(
                    DISPATCH_EVENT_TYPE,
                    7,
                    serde_json::json!({
                        "nonce": 7,
                        "origin_domain": 5,
                        "origin_mailbox": format!("{:#x}", H256::from_low_u64_be(3)),
                    }),
                ),
                &sources(),
            )
            .expect_err("wrong mailbox must reject");

        assert!(error.to_string().contains("configured mailbox"));
    }

    #[test]
    fn rejects_wrong_merkle_hook() {
        let mut state = StreamState::default();
        let error = state
            .validate(
                event(
                    MERKLE_EVENT_TYPE,
                    1,
                    serde_json::json!({
                        "domain": 5,
                        "leaf_index": "1",
                        "merkle_tree_hook": format!("{:#x}", H256::from_low_u64_be(3)),
                    }),
                ),
                &sources(),
            )
            .expect_err("wrong hook must reject");

        assert!(error.to_string().contains("configured hook"));
    }

    #[test]
    fn multiplexes_live_streams_on_one_subscription() {
        let message: serde_json::Value =
            serde_json::from_str(&subscription(vec![9, 5]).expect("subscription should serialize"))
                .expect("subscription JSON");

        assert_eq!(
            message,
            serde_json::json!({
                "streams": [
                    { "domains": [5, 9], "eventType": "dispatch" },
                    { "domains": [5, 9], "eventType": "merkle_tree_insertion" }
                ],
                "type": "subscribe"
            })
        );
    }
}
