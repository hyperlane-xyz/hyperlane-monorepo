//! Shadow validation of relayer inputs streamed by scraper-proxy.

use std::{
    collections::{BTreeMap, HashMap},
    time::Duration,
};

use eyre::{bail, Context, ContextCompat, Result};
use futures_util::{SinkExt, StreamExt};
use hyperlane_base::{
    scraper_websocket::{
        EventMessage, ServerMessage, StringOrNumber, SubscribeMessage, SubscribeStream,
    },
    CoreMetrics,
};
use hyperlane_core::{bytes_to_address, bytes_to_h512, HyperlaneMessage, H256, H512};
use prometheus::{IntCounterVec, IntGaugeVec};
use serde::Deserialize;
use sha3::{Digest, Keccak256};
use tokio::time::{sleep, timeout, Instant};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{info, warn};
use url::Url;

const DISPATCH_EVENT_TYPE: &str = "dispatch";
const MERKLE_EVENT_TYPE: &str = "merkle_tree_insertion";
const READ_TIMEOUT: Duration = Duration::from_secs(75);
const RETRY_DELAY: Duration = Duration::from_secs(5);
const DUPLICATE_FINGERPRINT_WINDOW: usize = 1_024;

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

type EventFingerprint = H256;

#[derive(Debug)]
struct StreamCursor {
    fingerprints: BTreeMap<u32, EventFingerprint>,
    next_sequence: u32,
}

impl StreamCursor {
    fn new(sequence: u32, fingerprint: EventFingerprint) -> Result<Self> {
        let mut fingerprints = BTreeMap::new();
        fingerprints.insert(sequence, fingerprint);
        Ok(Self {
            fingerprints,
            next_sequence: sequence
                .checked_add(1)
                .context("Scraper event sequence exhausted")?,
        })
    }

    fn validate(&mut self, sequence: u32, fingerprint: EventFingerprint) -> Result<SequenceResult> {
        if sequence < self.next_sequence {
            return match self.fingerprints.get(&sequence) {
                Some(previous) if previous == &fingerprint => Ok(SequenceResult::Duplicate),
                Some(_) => bail!("Conflicting scraper event at sequence {sequence}"),
                None => bail!(
                    "Scraper event sequence {sequence} is older than the retained duplicate window"
                ),
            };
        }
        if sequence > self.next_sequence {
            return Err(StreamGap {
                expected: self.next_sequence,
                received: sequence,
            }
            .into());
        }

        let next_sequence = self
            .next_sequence
            .checked_add(1)
            .context("Scraper event sequence exhausted")?;
        self.fingerprints.insert(sequence, fingerprint);
        while self.fingerprints.len() > DUPLICATE_FINGERPRINT_WINDOW {
            self.fingerprints.pop_first();
        }
        self.next_sequence = next_sequence;
        Ok(SequenceResult::Accepted)
    }
}

#[derive(Debug, thiserror::Error)]
#[error("Scraper stream gap: expected sequence {expected}, received {received}")]
struct StreamGap {
    expected: u32,
    received: u32,
}

#[derive(Debug, Default)]
struct StreamState {
    cursors: HashMap<(u32, EventKind), StreamCursor>,
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

        let (kind, fingerprint) = match event.event_type.as_str() {
            DISPATCH_EVENT_TYPE => {
                let data: DispatchEventData =
                    serde_json::from_value(event.data).context("Invalid dispatch event payload")?;
                if data.origin_domain != event.domain {
                    bail!("Dispatch payload domain does not match event envelope");
                }
                let origin_mailbox = parse_address(&data.origin_mailbox)?;
                if origin_mailbox != source.mailbox {
                    bail!("Dispatch event mailbox does not match configured mailbox");
                }
                let nonce = data.nonce.as_u32("dispatch nonce")?;
                if nonce != sequence {
                    bail!("Dispatch event nonce does not match stream sequence");
                }
                let body = parse_hex(
                    data.msg_body
                        .as_deref()
                        .context("Dispatch event omitted message body")?,
                )?;
                let message = HyperlaneMessage {
                    version: 3,
                    nonce,
                    origin: data.origin_domain,
                    sender: parse_address(&data.sender)?,
                    destination: data.destination_domain,
                    recipient: parse_address(&data.recipient)?,
                    body,
                };
                let message_id = parse_h256(&data.msg_id, "dispatch message ID")?;
                if message.id() != message_id {
                    bail!("Dispatch message ID does not match reconstructed message");
                }
                if data.time_created.is_empty() {
                    bail!("Dispatch event omitted creation time");
                }
                let origin_block_hash = parse_h256(&data.origin_block_hash, "origin block hash")?;
                let origin_block_height = data.origin_block_height.as_u64("origin block height")?;
                let origin_tx_hash = parse_h512(&data.origin_tx_hash)?;
                let row_id = data.id.as_u64("dispatch row ID")?;
                let row_id_bytes = row_id.to_be_bytes();
                let origin_block_height_bytes = origin_block_height.to_be_bytes();
                (
                    EventKind::Dispatch,
                    event_fingerprint(&[
                        b"dispatch",
                        &row_id_bytes,
                        message_id.as_ref(),
                        origin_block_hash.as_ref(),
                        &origin_block_height_bytes,
                        origin_mailbox.as_ref(),
                        origin_tx_hash.as_ref(),
                        data.time_created.as_bytes(),
                    ]),
                )
            }
            MERKLE_EVENT_TYPE => {
                let data: MerkleEventData = serde_json::from_value(event.data)
                    .context("Invalid Merkle tree insertion payload")?;
                if data.domain != event.domain {
                    bail!("Merkle payload domain does not match event envelope");
                }
                let merkle_tree_hook = parse_address(&data.merkle_tree_hook)?;
                if merkle_tree_hook != source.merkle_tree_hook {
                    bail!("Merkle event hook does not match configured hook");
                }
                let leaf_index = data.leaf_index.as_u32("Merkle leaf index")?;
                if leaf_index != sequence {
                    bail!("Merkle leaf index does not match stream sequence");
                }
                let block_number = data.block_number.as_u64("Merkle block number")?;
                let block_number_bytes = block_number.to_be_bytes();
                let message_id = parse_h256(&data.message_id, "Merkle message ID")?;
                (
                    EventKind::MerkleTreeInsertion,
                    event_fingerprint(&[
                        b"merkle_tree_insertion",
                        &block_number_bytes,
                        merkle_tree_hook.as_ref(),
                        message_id.as_ref(),
                    ]),
                )
            }
            event_type => bail!("Unexpected scraper event type {event_type}"),
        };

        let key = (event.domain, kind);
        let result = match self.cursors.get_mut(&key) {
            Some(cursor) => cursor.validate(sequence, fingerprint)?,
            None => {
                self.cursors
                    .insert(key, StreamCursor::new(sequence, fingerprint)?);
                SequenceResult::Accepted
            }
        };
        Ok((kind, result))
    }
}

#[derive(Debug, Default)]
struct HandshakeState {
    confirmed: bool,
    sent: bool,
}

impl HandshakeState {
    fn ready(&mut self) -> Result<()> {
        if self.sent {
            bail!("Received duplicate scraper-proxy ready message");
        }
        self.sent = true;
        Ok(())
    }

    fn subscribed(&mut self) -> Result<()> {
        if !self.sent {
            bail!("Received subscribed before ready");
        }
        if self.confirmed {
            bail!("Received duplicate scraper-proxy subscribed message");
        }
        self.confirmed = true;
        Ok(())
    }

    fn event(&self) -> Result<()> {
        if !self.confirmed {
            bail!("Received scraper event before subscription confirmation");
        }
        Ok(())
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
        let mut state = StreamState::default();
        loop {
            self.set_active(false);
            match self.stream(&mut state).await {
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

    async fn stream(&self, state: &mut StreamState) -> Result<()> {
        let (mut socket, _) = timeout(READ_TIMEOUT, connect_async(self.url.as_str()))
            .await
            .context("Connecting to relayer scraper-proxy WebSocket timed out")?
            .context("Connecting to relayer scraper-proxy WebSocket")?;
        let mut handshake = HandshakeState::default();
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
                            handshake.ready()?;
                            socket
                                .send(Message::Text(self.subscription()?))
                                .await
                                .context("Subscribing to relayer scraper-proxy streams")?;
                        }
                        ServerMessage::Subscribed => {
                            handshake.subscribed()?;
                            self.set_active(true);
                            info!("Relayer scraper-proxy shadow streams active");
                        }
                        ServerMessage::Event(event) => {
                            handshake.event()?;
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
#[serde(deny_unknown_fields)]
struct DispatchEventData {
    destination_domain: u32,
    id: StringOrNumber,
    msg_body: Option<String>,
    msg_id: String,
    nonce: StringOrNumber,
    origin_block_hash: String,
    origin_block_height: StringOrNumber,
    origin_domain: u32,
    origin_mailbox: String,
    origin_tx_hash: String,
    recipient: String,
    sender: String,
    time_created: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct MerkleEventData {
    block_number: StringOrNumber,
    domain: u32,
    leaf_index: StringOrNumber,
    merkle_tree_hook: String,
    message_id: String,
}

fn parse_address(value: &str) -> Result<H256> {
    bytes_to_address(parse_hex(value)?).context("Invalid scraper event address")
}

fn parse_h256(value: &str, field: &str) -> Result<H256> {
    let bytes = parse_hex(value)?;
    if bytes.len() != 32 {
        bail!("Invalid {field} length {}", bytes.len());
    }
    Ok(H256::from_slice(&bytes))
}

fn parse_h512(value: &str) -> Result<H512> {
    let bytes = parse_hex(value)?;
    if !matches!(bytes.len(), 32 | 64) {
        bail!("Invalid origin transaction hash length {}", bytes.len());
    }
    Ok(bytes_to_h512(&bytes))
}

fn event_fingerprint(fields: &[&[u8]]) -> H256 {
    let mut hasher = Keccak256::new();
    for field in fields {
        hasher.update((field.len() as u64).to_be_bytes());
        hasher.update(field);
    }
    H256::from_slice(&hasher.finalize())
}

fn parse_hex(value: &str) -> Result<Vec<u8>> {
    let value = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("\\x"))
        .unwrap_or(value);
    hex::decode(value).context("Invalid hexadecimal scraper event field")
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

    fn dispatch_data(nonce: u32, body: &[u8]) -> serde_json::Value {
        let message = HyperlaneMessage {
            version: 3,
            nonce,
            origin: 5,
            sender: H256::from_low_u64_be(3),
            destination: 6,
            recipient: H256::from_low_u64_be(4),
            body: body.to_vec(),
        };
        serde_json::json!({
            "destination_domain": message.destination,
            "id": "42",
            "msg_body": format!("\\x{}", hex::encode(&message.body)),
            "msg_id": format!("{:#x}", message.id()),
            "nonce": nonce,
            "origin_block_hash": format!("{:#x}", H256::from_low_u64_be(5)),
            "origin_block_height": "100",
            "origin_domain": message.origin,
            "origin_mailbox": format!("{:#x}", H256::from_low_u64_be(1)),
            "origin_tx_hash": format!("\\x{}", hex::encode([6_u8; 32])),
            "recipient": format!("{:#x}", message.recipient),
            "sender": format!("{:#x}", message.sender),
            "time_created": "2026-08-30T00:00:00.000Z",
        })
    }

    fn merkle_data(index: u32, hook: H256) -> serde_json::Value {
        serde_json::json!({
            "block_number": "101",
            "domain": 5,
            "leaf_index": index,
            "merkle_tree_hook": format!("{hook:#x}"),
            "message_id": format!("{:#x}", H256::from_low_u64_be(7)),
        })
    }

    #[test]
    fn preserves_sequence_across_reconnects() {
        let sources = sources();
        let mut contiguous = StreamState::default();

        assert_eq!(
            contiguous
                .validate(
                    event(DISPATCH_EVENT_TYPE, 7, dispatch_data(7, b"seven")),
                    &sources,
                )
                .expect("first event"),
            (EventKind::Dispatch, SequenceResult::Accepted)
        );
        assert_eq!(
            contiguous
                .validate(
                    event(DISPATCH_EVENT_TYPE, 7, dispatch_data(7, b"seven")),
                    &sources,
                )
                .expect("duplicate event after reconnect"),
            (EventKind::Dispatch, SequenceResult::Duplicate)
        );
        assert_eq!(
            contiguous
                .validate(
                    event(DISPATCH_EVENT_TYPE, 8, dispatch_data(8, b"eight")),
                    &sources,
                )
                .expect("next event after reconnect"),
            (EventKind::Dispatch, SequenceResult::Accepted)
        );

        let mut gapped = StreamState::default();
        gapped
            .validate(
                event(DISPATCH_EVENT_TYPE, 7, dispatch_data(7, b"seven")),
                &sources,
            )
            .expect("first event before reconnect");
        assert!(gapped
            .validate(
                event(DISPATCH_EVENT_TYPE, 9, dispatch_data(9, b"nine")),
                &sources,
            )
            .expect_err("gap must reject")
            .to_string()
            .contains("expected sequence 8"));
    }

    #[test]
    fn rejects_conflicting_duplicate_dispatch() {
        let sources = sources();
        let mut state = StreamState::default();
        state
            .validate(
                event(DISPATCH_EVENT_TYPE, 7, dispatch_data(7, b"original")),
                &sources,
            )
            .expect("first event");

        assert!(state
            .validate(
                event(DISPATCH_EVENT_TYPE, 7, dispatch_data(7, b"conflict")),
                &sources,
            )
            .expect_err("conflicting duplicate must reject")
            .to_string()
            .contains("Conflicting scraper event"));
    }

    #[test]
    fn rejects_invalid_dispatch_payload() {
        let mut bad_body = dispatch_data(7, b"original");
        bad_body["msg_body"] = serde_json::json!("\\x00");
        assert!(StreamState::default()
            .validate(event(DISPATCH_EVENT_TYPE, 7, bad_body), &sources())
            .expect_err("message ID mismatch must reject")
            .to_string()
            .contains("message ID"));

        let mut bad_sender = dispatch_data(7, b"original");
        bad_sender["sender"] = serde_json::json!("0x12");
        assert!(StreamState::default()
            .validate(event(DISPATCH_EVENT_TYPE, 7, bad_sender), &sources())
            .expect_err("invalid sender must reject")
            .to_string()
            .contains("address"));
    }

    #[test]
    fn rejects_wrong_dispatch_mailbox() {
        let mut data = dispatch_data(7, b"payload");
        data["origin_mailbox"] = serde_json::json!(format!("{:#x}", H256::from_low_u64_be(3)));
        let error = StreamState::default()
            .validate(event(DISPATCH_EVENT_TYPE, 7, data), &sources())
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
                    merkle_data(1, H256::from_low_u64_be(3)),
                ),
                &sources(),
            )
            .expect_err("wrong hook must reject");

        assert!(error.to_string().contains("configured hook"));
    }

    #[test]
    fn validates_merkle_payload_fields() {
        let mut data = merkle_data(1, H256::from_low_u64_be(2));
        data["message_id"] = serde_json::json!("0x12");
        assert!(StreamState::default()
            .validate(event(MERKLE_EVENT_TYPE, 1, data), &sources())
            .expect_err("invalid message ID must reject")
            .to_string()
            .contains("Merkle message ID"));
    }

    #[test]
    fn rejects_fields_outside_wire_projection() {
        let mut dispatch = dispatch_data(7, b"payload");
        dispatch["time_updated"] = serde_json::json!("2026-08-30T00:00:01.000Z");
        assert!(StreamState::default()
            .validate(event(DISPATCH_EVENT_TYPE, 7, dispatch), &sources())
            .expect_err("unprojected dispatch field must reject")
            .to_string()
            .contains("Invalid dispatch event payload"));

        let mut merkle = merkle_data(1, H256::from_low_u64_be(2));
        merkle["id"] = serde_json::json!(42);
        assert!(StreamState::default()
            .validate(event(MERKLE_EVENT_TYPE, 1, merkle), &sources())
            .expect_err("unprojected Merkle field must reject")
            .to_string()
            .contains("Invalid Merkle tree insertion payload"));
    }

    #[test]
    fn enforces_subscription_handshake_order() {
        let mut handshake = HandshakeState::default();
        assert!(handshake.event().is_err());
        assert!(handshake.subscribed().is_err());
        handshake.ready().expect("ready");
        assert!(handshake.event().is_err());
        handshake.subscribed().expect("subscribed");
        handshake.event().expect("event after confirmation");
        assert!(handshake.subscribed().is_err());
        assert!(handshake.ready().is_err());
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
