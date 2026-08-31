//! Shadow validation of relayer inputs streamed by scraper-proxy.

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    time::Duration,
};

use eyre::{bail, Context, ContextCompat, Result};
use futures_util::{SinkExt, StreamExt};
use hyperlane_base::{
    db::HyperlaneRocksDB,
    scraper_websocket::{
        EventMessage, SequenceCursor, ServerMessage, StringOrNumber, SubscribeMessage,
        SubscribeStream, SubscribedCursor, SubscribedStream,
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
const CROSS_STREAM_WINDOW: usize = 1_024;
const DISPATCH_CURSOR_PREFIX: &[u8] = b"scraper_websocket_dispatch_cursor";
const MERKLE_CURSOR_PREFIX: &[u8] = b"scraper_websocket_merkle_cursor";

#[derive(Clone, Debug)]
pub(crate) struct ScraperSource {
    chain: String,
    db: HyperlaneRocksDB,
    domain: u32,
    mailbox: H256,
    merkle_tree_hook: H256,
}

impl ScraperSource {
    pub(crate) fn new(
        chain: String,
        db: HyperlaneRocksDB,
        domain: u32,
        mailbox: H256,
        merkle_tree_hook: H256,
    ) -> Self {
        Self {
            chain,
            db,
            domain,
            mailbox,
            merkle_tree_hook,
        }
    }

    fn address(&self, kind: EventKind) -> H256 {
        match kind {
            EventKind::Dispatch => self.mailbox,
            EventKind::MerkleTreeInsertion => self.merkle_tree_hook,
        }
    }

    fn cursor(&self, kind: EventKind) -> Result<Option<u32>> {
        self.db
            .retrieve_value_by_key(kind.cursor_prefix(), &self.address(kind))
            .context("Reading durable scraper WebSocket cursor")
    }

    fn store_cursor(&self, kind: EventKind, sequence: u32) -> Result<()> {
        if self.cursor(kind)?.is_some_and(|stored| stored >= sequence) {
            return Ok(());
        }
        self.db
            .store_value_by_key(kind.cursor_prefix(), &self.address(kind), &sequence)
            .context("Storing durable scraper WebSocket cursor")
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

    fn cursor_prefix(self) -> &'static [u8] {
        match self {
            Self::Dispatch => DISPATCH_CURSOR_PREFIX,
            Self::MerkleTreeInsertion => MERKLE_CURSOR_PREFIX,
        }
    }

    fn counterpart(self) -> Self {
        match self {
            Self::Dispatch => Self::MerkleTreeInsertion,
            Self::MerkleTreeInsertion => Self::Dispatch,
        }
    }

    fn from_label(label: &str) -> Result<Self> {
        match label {
            DISPATCH_EVENT_TYPE => Ok(Self::Dispatch),
            MERKLE_EVENT_TYPE => Ok(Self::MerkleTreeInsertion),
            _ => bail!("Unexpected scraper event type {label}"),
        }
    }
}

#[derive(Debug, Eq, PartialEq)]
enum SequenceResult {
    Accepted,
    Duplicate,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ProtocolProjection {
    block_number: u64,
    message_id: H256,
}

#[derive(Debug, Default)]
struct CrossStreamPair {
    dispatch: Option<ProtocolProjection>,
    merkle: Option<ProtocolProjection>,
}

impl CrossStreamPair {
    fn complete(&self) -> bool {
        self.dispatch.is_some() && self.merkle.is_some()
    }

    fn get(&self, kind: EventKind) -> Option<ProtocolProjection> {
        match kind {
            EventKind::Dispatch => self.dispatch,
            EventKind::MerkleTreeInsertion => self.merkle,
        }
    }

    fn get_mut(&mut self, kind: EventKind) -> &mut Option<ProtocolProjection> {
        match kind {
            EventKind::Dispatch => &mut self.dispatch,
            EventKind::MerkleTreeInsertion => &mut self.merkle,
        }
    }
}

#[derive(Debug, Default)]
struct CrossStreamState {
    entries: HashMap<u32, BTreeMap<u32, CrossStreamPair>>,
}

impl CrossStreamState {
    fn complete(&self, domain: u32, sequence: u32) -> bool {
        self.entries
            .get(&domain)
            .and_then(|entries| entries.get(&sequence))
            .is_some_and(CrossStreamPair::complete)
    }

    fn validate(
        &mut self,
        domain: u32,
        sequence: u32,
        kind: EventKind,
        projection: ProtocolProjection,
    ) -> Result<()> {
        let entries = self.entries.entry(domain).or_default();

        let mismatch = if let Some(pair) = entries.get(&sequence) {
            if let Some(previous) = pair.get(kind) {
                if previous != projection {
                    bail!("Conflicting scraper projection at sequence {sequence}");
                }
            }
            if let Some(counterpart) = pair.get(match kind {
                EventKind::Dispatch => EventKind::MerkleTreeInsertion,
                EventKind::MerkleTreeInsertion => EventKind::Dispatch,
            }) {
                if counterpart.message_id != projection.message_id {
                    Some(format!(
                        "Dispatch and Merkle message IDs differ at sequence {sequence}"
                    ))
                } else if counterpart.block_number != projection.block_number {
                    Some(format!(
                        "Dispatch and Merkle block numbers differ at sequence {sequence}"
                    ))
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        };
        if let Some(mismatch) = mismatch {
            bail!(mismatch);
        }
        if !entries.contains_key(&sequence) && entries.len() >= CROSS_STREAM_WINDOW {
            let oldest_complete = entries
                .first_key_value()
                .is_some_and(|(_, pair)| pair.complete());
            if !oldest_complete {
                bail!("Scraper cross-stream skew exceeds {CROSS_STREAM_WINDOW} sequences");
            }
        }

        if !entries.contains_key(&sequence) && entries.len() >= CROSS_STREAM_WINDOW {
            entries.pop_first();
        }
        let pair = entries.entry(sequence).or_default();
        *pair.get_mut(kind) = Some(projection);
        Ok(())
    }
}

type EventFingerprint = H256;

#[derive(Debug)]
struct StreamCursor {
    fingerprints: BTreeMap<u32, EventFingerprint>,
    next_sequence: u32,
}

impl StreamCursor {
    fn from_durable_sequence(sequence: u32) -> Self {
        Self {
            fingerprints: BTreeMap::new(),
            next_sequence: sequence,
        }
    }

    fn from_after_sequence(sequence: u32) -> Result<Self> {
        Ok(Self {
            fingerprints: BTreeMap::new(),
            next_sequence: sequence
                .checked_add(1)
                .context("Scraper event sequence exhausted")?,
        })
    }

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

    fn check(&self, sequence: u32, fingerprint: EventFingerprint) -> Result<SequenceResult> {
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

        self.next_sequence
            .checked_add(1)
            .context("Scraper event sequence exhausted")?;

        Ok(SequenceResult::Accepted)
    }

    fn accept(&mut self, sequence: u32, fingerprint: EventFingerprint) -> Result<()> {
        self.next_sequence = self
            .next_sequence
            .checked_add(1)
            .context("Scraper event sequence exhausted")?;
        self.fingerprints.insert(sequence, fingerprint);
        while self.fingerprints.len() > DUPLICATE_FINGERPRINT_WINDOW {
            self.fingerprints.pop_first();
        }
        Ok(())
    }

    fn latest_sequence(&self) -> Result<u32> {
        self.next_sequence
            .checked_sub(1)
            .context("Scraper cursor has no accepted sequence")
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
    cross_stream: CrossStreamState,
    cursors: HashMap<(u32, EventKind), StreamCursor>,
}

impl StreamState {
    fn load(sources: &HashMap<u32, ScraperSource>) -> Result<Self> {
        let mut state = Self::default();
        for source in sources.values() {
            for kind in [EventKind::Dispatch, EventKind::MerkleTreeInsertion] {
                if let Some(sequence) = source.cursor(kind)? {
                    state.cursors.insert(
                        (source.domain, kind),
                        StreamCursor::from_durable_sequence(sequence),
                    );
                }
            }
        }
        Ok(state)
    }

    fn set_baseline(&mut self, domain: u32, kind: EventKind, sequence: i64) -> Result<()> {
        if self.cursors.contains_key(&(domain, kind)) || sequence < 0 {
            return Ok(());
        }
        let sequence: u32 = sequence
            .try_into()
            .context("Scraper caught-up sequence exceeds u32")?;
        self.cursors
            .insert((domain, kind), StreamCursor::from_after_sequence(sequence)?);
        Ok(())
    }

    fn latest_sequence(&self, domain: u32, kind: EventKind) -> Result<u32> {
        self.cursors
            .get(&(domain, kind))
            .context("Validated scraper stream has no cursor")?
            .latest_sequence()
    }

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

        let (kind, fingerprint, projection) = match event.event_type.as_str() {
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
                    ProtocolProjection {
                        block_number: origin_block_height,
                        message_id,
                    },
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
                    ProtocolProjection {
                        block_number,
                        message_id,
                    },
                )
            }
            event_type => bail!("Unexpected scraper event type {event_type}"),
        };

        let key = (event.domain, kind);
        let new_cursor = if self.cursors.contains_key(&key) {
            None
        } else {
            Some(StreamCursor::new(sequence, fingerprint)?)
        };
        let result = match self.cursors.get(&key) {
            Some(cursor) => cursor.check(sequence, fingerprint)?,
            None => SequenceResult::Accepted,
        };
        self.cross_stream
            .validate(event.domain, sequence, kind, projection)?;
        if result == SequenceResult::Accepted {
            match self.cursors.get_mut(&key) {
                Some(cursor) => cursor.accept(sequence, fingerprint)?,
                None => {
                    let _ = self.cursors.insert(
                        key,
                        new_cursor.expect("new cursor is prepared before persistence"),
                    );
                }
            }
        }
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

    fn subscribed(
        &mut self,
        streams: &[SubscribedStream],
        sources: &HashMap<u32, ScraperSource>,
    ) -> Result<()> {
        if !self.sent {
            bail!("Received subscribed before ready");
        }
        if self.confirmed {
            bail!("Received duplicate scraper-proxy subscribed message");
        }
        validate_subscription(streams, sources)?;
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
    caught_up: IntGaugeVec,
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
        let caught_up = metrics.new_int_gauge(
            "relayer_scraper_websocket_caught_up",
            "Whether scraper-proxy replay reached the durable cursor",
            &["chain", "event_type"],
        )?;
        let sources = sources
            .into_iter()
            .map(|source| (source.domain, source))
            .collect::<HashMap<_, _>>();
        for source in sources.values() {
            active.with_label_values(&[source.chain.as_str()]).set(0);
            for kind in [EventKind::Dispatch, EventKind::MerkleTreeInsertion] {
                caught_up
                    .with_label_values(&[source.chain.as_str(), kind.label()])
                    .set(0);
            }
        }
        Ok(Self {
            active,
            caught_up,
            events,
            sources,
            url,
        })
    }

    pub(crate) async fn run(self) {
        let mut state = loop {
            match StreamState::load(&self.sources) {
                Ok(state) => break state,
                Err(err) => {
                    warn!(
                        ?err,
                        "Loading durable scraper WebSocket cursors failed; retrying"
                    );
                    sleep(RETRY_DELAY).await;
                }
            }
        };
        loop {
            self.set_active(false);
            self.set_caught_up(false);
            match self.stream(&mut state).await {
                Ok(()) => warn!("Relayer scraper-proxy shadow stream closed; reconnecting"),
                Err(err) => warn!(
                    ?err,
                    "Relayer scraper-proxy shadow stream failed; reconnecting"
                ),
            }
            self.set_active(false);
            self.set_caught_up(false);
            sleep(RETRY_DELAY).await;
        }
    }

    async fn stream(&self, state: &mut StreamState) -> Result<()> {
        let (mut socket, _) = timeout(READ_TIMEOUT, connect_async(self.url.as_str()))
            .await
            .context("Connecting to relayer scraper-proxy WebSocket timed out")?
            .context("Connecting to relayer scraper-proxy WebSocket")?;
        let mut handshake = HandshakeState::default();
        let mut correlation_required = HashSet::new();
        for source in self.sources.values() {
            for kind in [EventKind::Dispatch, EventKind::MerkleTreeInsertion] {
                if source.cursor(kind)?.is_some() {
                    correlation_required.insert(source.domain);
                    break;
                }
            }
        }
        let mut caught_up = HashMap::new();
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
                        ServerMessage::Subscribed { streams } => {
                            handshake.subscribed(&streams, &self.sources)?;
                            self.set_active(true);
                            info!("Relayer scraper-proxy shadow streams active");
                        }
                        ServerMessage::Event(event) => {
                            handshake.event()?;
                            let domain = event.domain;
                            let event_type = event_label(&event.event_type);
                            match state.validate(event, &self.sources) {
                                Ok((kind, sequence_result)) => {
                                    let sequence = state.latest_sequence(domain, kind)?;
                                    self.sources
                                        .get(&domain)
                                        .expect("validated scraper source exists")
                                        .store_cursor(kind, sequence)?;
                                    let result = match sequence_result {
                                        SequenceResult::Accepted => "accepted",
                                        SequenceResult::Duplicate => "duplicate",
                                    };
                                    self.record(domain, kind.label(), result);
                                    self.update_source_caught_up(
                                        state,
                                        &correlation_required,
                                        &caught_up,
                                        domain,
                                    )?;
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
                        ServerMessage::CaughtUp {
                            address,
                            domain,
                            event_type,
                            sequence,
                        } => {
                            handshake.event()?;
                            let kind = EventKind::from_label(&event_type)?;
                            let source = self.sources.get(&domain).with_context(|| {
                                format!("Unexpected scraper caught-up domain {domain}")
                            })?;
                            if parse_address(&address)? != source.address(kind) {
                                bail!(
                                    "Scraper caught-up address does not match configured contract"
                                );
                            }
                            let sequence = sequence
                                .parse::<i64>()
                                .context("Invalid scraper caught-up sequence")?;
                            if sequence < -1 {
                                bail!("Invalid negative scraper caught-up sequence {sequence}");
                            }
                            if let Some(stored) = source.cursor(kind)? {
                                if sequence < i64::from(stored) {
                                    bail!(
                                        "Scraper caught-up sequence {sequence} is behind durable cursor {stored}"
                                    );
                                }
                            }
                            if sequence >= 0 {
                                let durable: u32 = sequence
                                    .try_into()
                                    .context("Scraper caught-up sequence exceeds u32")?;
                                source.store_cursor(kind, durable)?;
                            }
                            state.set_baseline(domain, kind, sequence)?;
                            if caught_up.insert((domain, kind), sequence).is_some() {
                                bail!("Received duplicate scraper caught-up marker");
                            }
                            self.update_source_caught_up(
                                state,
                                &correlation_required,
                                &caught_up,
                                domain,
                            )?;
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
        subscription(&self.sources)
    }

    fn set_active(&self, active: bool) {
        let value = i64::from(active);
        for source in self.sources.values() {
            self.active
                .with_label_values(&[source.chain.as_str()])
                .set(value);
        }
    }

    fn set_caught_up(&self, caught_up: bool) {
        for source in self.sources.values() {
            for kind in [EventKind::Dispatch, EventKind::MerkleTreeInsertion] {
                self.set_source_caught_up(source, kind, caught_up);
            }
        }
    }

    fn set_source_caught_up(&self, source: &ScraperSource, kind: EventKind, caught_up: bool) {
        self.caught_up
            .with_label_values(&[source.chain.as_str(), kind.label()])
            .set(i64::from(caught_up));
    }

    fn update_source_caught_up(
        &self,
        state: &StreamState,
        correlation_required: &HashSet<u32>,
        caught_up: &HashMap<(u32, EventKind), i64>,
        domain: u32,
    ) -> Result<()> {
        if !source_caught_up(
            correlation_required.contains(&domain),
            caught_up,
            state,
            domain,
        )? {
            return Ok(());
        }
        let source = self
            .sources
            .get(&domain)
            .context("Validated scraper source is missing")?;
        for kind in [EventKind::Dispatch, EventKind::MerkleTreeInsertion] {
            self.set_source_caught_up(source, kind, true);
        }
        Ok(())
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

fn subscription(sources: &HashMap<u32, ScraperSource>) -> Result<String> {
    let mut sources = sources.values().collect::<Vec<_>>();
    sources.sort_unstable_by_key(|source| source.domain);
    let domains = sources
        .iter()
        .map(|source| source.domain)
        .collect::<Vec<_>>();
    let cursors = |kind| -> Result<Vec<SequenceCursor>> {
        sources
            .iter()
            .map(|source| sequence_cursor(source, kind))
            .collect()
    };
    serde_json::to_string(&SubscribeMessage {
        streams: vec![
            SubscribeStream {
                cursors: Some(cursors(EventKind::Dispatch)?),
                domains: Some(domains.clone()),
                event_type: DISPATCH_EVENT_TYPE,
            },
            SubscribeStream {
                cursors: Some(cursors(EventKind::MerkleTreeInsertion)?),
                domains: Some(domains),
                event_type: MERKLE_EVENT_TYPE,
            },
        ],
        message_type: "subscribe",
    })
    .context("Serializing relayer scraper-proxy subscription")
}

fn sequence_cursor(source: &ScraperSource, kind: EventKind) -> Result<SequenceCursor> {
    let replay_from = match source.cursor(kind)? {
        Some(sequence) => Some(sequence),
        None => source.cursor(kind.counterpart())?,
    };
    Ok(SequenceCursor {
        address: format!("{:#x}", source.address(kind)),
        allow_replay: Some(true),
        after_sequence: replay_from.map(replay_after_sequence),
        domain: source.domain,
    })
}

fn replay_after_sequence(sequence: u32) -> String {
    sequence
        .checked_sub(1)
        .map(|sequence| sequence.to_string())
        .unwrap_or_else(|| "-1".to_owned())
}

fn correlation_ready(
    required: bool,
    state: &StreamState,
    domain: u32,
    sequence: i64,
) -> Result<bool> {
    if sequence < 0 || !required {
        return Ok(true);
    }
    Ok(state.cross_stream.complete(
        domain,
        sequence
            .try_into()
            .context("Caught-up sequence exceeds u32")?,
    ))
}

fn source_caught_up(
    correlation_required: bool,
    caught_up: &HashMap<(u32, EventKind), i64>,
    state: &StreamState,
    domain: u32,
) -> Result<bool> {
    let Some(dispatch) = caught_up.get(&(domain, EventKind::Dispatch)) else {
        return Ok(false);
    };
    let Some(merkle) = caught_up.get(&(domain, EventKind::MerkleTreeInsertion)) else {
        return Ok(false);
    };
    if !correlation_required {
        return Ok(true);
    }
    let target = (*dispatch).max(*merkle);
    if target < 0 {
        return Ok(true);
    }
    let target: u32 = target
        .try_into()
        .context("Caught-up sequence exceeds u32")?;
    for kind in [EventKind::Dispatch, EventKind::MerkleTreeInsertion] {
        let Some(cursor) = state.cursors.get(&(domain, kind)) else {
            return Ok(false);
        };
        if cursor.latest_sequence()? < target {
            return Ok(false);
        }
    }
    correlation_ready(true, state, domain, i64::from(target))
}

fn validate_subscription(
    streams: &[SubscribedStream],
    sources: &HashMap<u32, ScraperSource>,
) -> Result<()> {
    if streams.len() != 2 {
        bail!("Scraper-proxy confirmed an unexpected number of streams");
    }
    let mut sources = sources.values().collect::<Vec<_>>();
    sources.sort_unstable_by_key(|source| source.domain);
    let domains = sources
        .iter()
        .map(|source| source.domain)
        .collect::<Vec<_>>();
    for (stream, kind) in streams
        .iter()
        .zip([EventKind::Dispatch, EventKind::MerkleTreeInsertion])
    {
        let expected_cursors = sources
            .iter()
            .map(|source| {
                let cursor = sequence_cursor(source, kind)?;
                Ok(SubscribedCursor {
                    address: cursor.address,
                    after_sequence: cursor.after_sequence,
                    domain: source.domain,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        if stream.event_type != kind.label()
            || stream.cursors.as_deref() != Some(expected_cursors.as_slice())
            || stream.domains.as_deref() != Some(domains.as_slice())
        {
            bail!("Scraper-proxy subscription confirmation does not match request");
        }
    }
    Ok(())
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
    use hyperlane_base::db::test_utils;
    use hyperlane_core::HyperlaneDomain;

    fn sources() -> HashMap<u32, ScraperSource> {
        sources_for(&[5])
    }

    fn sources_for(domains: &[u32]) -> HashMap<u32, ScraperSource> {
        let tempdir = tempfile::tempdir().expect("temporary scraper cursor DB");
        let db = test_utils::setup_db(tempdir.path().to_string_lossy().into_owned());
        std::mem::forget(tempdir);
        domains
            .iter()
            .copied()
            .map(|domain| {
                let chain = format!("test-{domain}");
                let db =
                    HyperlaneRocksDB::new(&HyperlaneDomain::new_test_domain(&chain), db.clone());
                (
                    domain,
                    ScraperSource::new(
                        chain,
                        db,
                        domain,
                        H256::from_low_u64_be(1),
                        H256::from_low_u64_be(2),
                    ),
                )
            })
            .collect()
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

    fn dispatch_message(nonce: u32, body: &[u8]) -> HyperlaneMessage {
        HyperlaneMessage {
            version: 3,
            nonce,
            origin: 5,
            sender: H256::from_low_u64_be(3),
            destination: 6,
            recipient: H256::from_low_u64_be(4),
            body: body.to_vec(),
        }
    }

    fn dispatch_data(nonce: u32, body: &[u8]) -> serde_json::Value {
        let message = dispatch_message(nonce, body);
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
        merkle_data_for(index, hook, H256::from_low_u64_be(7), 101)
    }

    fn merkle_data_for(
        index: u32,
        hook: H256,
        message_id: H256,
        block_number: u64,
    ) -> serde_json::Value {
        serde_json::json!({
            "block_number": block_number.to_string(),
            "domain": 5,
            "leaf_index": index,
            "merkle_tree_hook": format!("{hook:#x}"),
            "message_id": format!("{message_id:#x}"),
        })
    }

    fn subscribed_streams(sources: &HashMap<u32, ScraperSource>) -> Vec<SubscribedStream> {
        let mut sources = sources.values().collect::<Vec<_>>();
        sources.sort_unstable_by_key(|source| source.domain);
        let domains = sources
            .iter()
            .map(|source| source.domain)
            .collect::<Vec<_>>();
        [EventKind::Dispatch, EventKind::MerkleTreeInsertion]
            .into_iter()
            .map(|kind| SubscribedStream {
                cursors: Some(
                    sources
                        .iter()
                        .map(|source| {
                            let cursor = sequence_cursor(source, kind).expect("cursor read");
                            SubscribedCursor {
                                address: cursor.address,
                                after_sequence: cursor.after_sequence,
                                domain: source.domain,
                            }
                        })
                        .collect(),
                ),
                domains: Some(domains.clone()),
                event_type: kind.label().to_owned(),
            })
            .collect()
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
    fn restores_durable_sequence_after_process_restart() {
        let sources = sources();
        let mut first_process = StreamState::load(&sources).expect("initial cursor load");
        first_process
            .validate(
                event(DISPATCH_EVENT_TYPE, 7, dispatch_data(7, b"seven")),
                &sources,
            )
            .expect("persist first event");
        sources[&5]
            .store_cursor(EventKind::Dispatch, 7)
            .expect("store first event cursor");

        let mut restarted = StreamState::load(&sources).expect("restart cursor load");
        restarted
            .validate(
                event(DISPATCH_EVENT_TYPE, 7, dispatch_data(7, b"seven")),
                &sources,
            )
            .expect("replay durable boundary");
        assert!(restarted
            .validate(
                event(DISPATCH_EVENT_TYPE, 9, dispatch_data(9, b"nine")),
                &sources,
            )
            .expect_err("restart gap must reject")
            .to_string()
            .contains("expected sequence 8"));
        restarted
            .validate(
                event(DISPATCH_EVENT_TYPE, 8, dispatch_data(8, b"eight")),
                &sources,
            )
            .expect("replayed event after durable cursor");
    }

    #[test]
    fn restart_replays_both_stream_boundaries_before_caught_up() {
        let sources = sources();
        let source = &sources[&5];
        source
            .store_cursor(EventKind::Dispatch, 7)
            .expect("store dispatch cursor");
        source
            .store_cursor(EventKind::MerkleTreeInsertion, 6)
            .expect("store Merkle cursor");

        let mut restarted = StreamState::load(&sources).expect("restart cursor load");
        restarted
            .validate(
                event(DISPATCH_EVENT_TYPE, 7, dispatch_data(7, b"seven")),
                &sources,
            )
            .expect("replay dispatch boundary");
        restarted
            .validate(
                event(
                    MERKLE_EVENT_TYPE,
                    6,
                    merkle_data_for(
                        6,
                        H256::from_low_u64_be(2),
                        dispatch_message(6, b"six").id(),
                        100,
                    ),
                ),
                &sources,
            )
            .expect("replay Merkle boundary");
        assert!(!correlation_ready(true, &restarted, 5, 7).expect("readiness check"));
        restarted
            .validate(
                event(
                    MERKLE_EVENT_TYPE,
                    7,
                    merkle_data_for(
                        7,
                        H256::from_low_u64_be(2),
                        dispatch_message(7, b"seven").id(),
                        100,
                    ),
                ),
                &sources,
            )
            .expect("complete split cursor pair");

        assert!(restarted.cross_stream.entries[&5][&7].complete());
        assert!(correlation_ready(true, &restarted, 5, 7).expect("readiness check"));
        assert_eq!(
            restarted
                .latest_sequence(5, EventKind::MerkleTreeInsertion)
                .expect("Merkle cursor"),
            7
        );
    }

    #[test]
    fn restart_replays_missing_peer_and_rechecks_late_correlation() {
        let sources = sources();
        let source = &sources[&5];
        source
            .store_cursor(EventKind::Dispatch, 7)
            .expect("store dispatch cursor");

        let message: serde_json::Value =
            serde_json::from_str(&subscription(&sources).expect("subscription should serialize"))
                .expect("subscription JSON");
        assert_eq!(message["streams"][0]["cursors"][0]["afterSequence"], "6");
        assert_eq!(message["streams"][1]["cursors"][0]["afterSequence"], "6");
        let streams = subscribed_streams(&sources);
        assert_eq!(
            streams[0].cursors.as_ref().expect("dispatch cursors")[0].after_sequence,
            Some("6".to_owned())
        );
        assert_eq!(
            streams[1].cursors.as_ref().expect("Merkle cursors")[0].after_sequence,
            Some("6".to_owned())
        );
        validate_subscription(&streams, &sources).expect("subscription confirmation");

        let mut restarted = StreamState::load(&sources).expect("restart cursor load");
        restarted
            .validate(
                event(DISPATCH_EVENT_TYPE, 7, dispatch_data(7, b"seven")),
                &sources,
            )
            .expect("replay dispatch boundary");
        let caught_up = HashMap::from([
            ((5, EventKind::Dispatch), 7),
            ((5, EventKind::MerkleTreeInsertion), 6),
        ]);
        assert!(!source_caught_up(true, &caught_up, &restarted, 5).expect("readiness check"));

        restarted
            .validate(
                event(
                    MERKLE_EVENT_TYPE,
                    7,
                    merkle_data_for(
                        7,
                        H256::from_low_u64_be(2),
                        dispatch_message(7, b"seven").id(),
                        100,
                    ),
                ),
                &sources,
            )
            .expect("late Merkle correlation");
        assert!(source_caught_up(true, &caught_up, &restarted, 5).expect("readiness check"));
    }

    #[test]
    fn replay_includes_zero_boundary() {
        assert_eq!(replay_after_sequence(0), "-1");
        assert_eq!(replay_after_sequence(1), "0");
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
    fn correlates_dispatch_and_merkle_projection() {
        let mut state = StreamState::default();
        let message = dispatch_message(7, b"payload");
        state
            .validate(
                event(DISPATCH_EVENT_TYPE, 7, dispatch_data(7, b"payload")),
                &sources(),
            )
            .expect("dispatch should validate");
        state
            .validate(
                event(
                    MERKLE_EVENT_TYPE,
                    7,
                    merkle_data_for(7, H256::from_low_u64_be(2), message.id(), 100),
                ),
                &sources(),
            )
            .expect("matching Merkle insertion should validate");
    }

    #[test]
    fn rejects_cross_stream_message_and_block_mismatches() {
        let message = dispatch_message(7, b"payload");
        let mut wrong_message = StreamState::default();
        wrong_message
            .validate(
                event(DISPATCH_EVENT_TYPE, 7, dispatch_data(7, b"payload")),
                &sources(),
            )
            .expect("dispatch should validate");
        assert!(wrong_message
            .validate(
                event(
                    MERKLE_EVENT_TYPE,
                    7,
                    merkle_data_for(7, H256::from_low_u64_be(2), H256::from_low_u64_be(8), 100,),
                ),
                &sources(),
            )
            .expect_err("message mismatch must reject")
            .to_string()
            .contains("message IDs differ"));

        let mut wrong_block = StreamState::default();
        wrong_block
            .validate(
                event(DISPATCH_EVENT_TYPE, 7, dispatch_data(7, b"payload")),
                &sources(),
            )
            .expect("dispatch should validate");
        assert!(wrong_block
            .validate(
                event(
                    MERKLE_EVENT_TYPE,
                    7,
                    merkle_data_for(7, H256::from_low_u64_be(2), message.id(), 101),
                ),
                &sources(),
            )
            .expect_err("block mismatch must reject")
            .to_string()
            .contains("block numbers differ"));
    }

    #[test]
    fn bounds_unmatched_cross_stream_projections() {
        let projection = ProtocolProjection {
            block_number: 100,
            message_id: H256::from_low_u64_be(7),
        };
        let mut state = CrossStreamState::default();
        for sequence in 0..CROSS_STREAM_WINDOW as u32 {
            state
                .validate(5, sequence, EventKind::Dispatch, projection)
                .expect("projection inside window");
        }
        assert_eq!(state.entries[&5].len(), CROSS_STREAM_WINDOW);
        assert!(state
            .validate(
                5,
                CROSS_STREAM_WINDOW as u32,
                EventKind::Dispatch,
                projection,
            )
            .expect_err("unmatched projection must not be evicted")
            .to_string()
            .contains("skew exceeds"));

        state
            .validate(5, 0, EventKind::MerkleTreeInsertion, projection)
            .expect("oldest projection should complete");
        state
            .validate(
                5,
                CROSS_STREAM_WINDOW as u32,
                EventKind::Dispatch,
                projection,
            )
            .expect("completed oldest projection should be evicted");
        assert_eq!(state.entries[&5].len(), CROSS_STREAM_WINDOW);
        assert!(!state.entries[&5].contains_key(&0));
        assert!(state.entries[&5].contains_key(&(CROSS_STREAM_WINDOW as u32)));
    }

    #[test]
    fn enforces_subscription_handshake_order() {
        let mut handshake = HandshakeState::default();
        let sources = sources();
        let streams = subscribed_streams(&sources);
        assert!(handshake.event().is_err());
        assert!(handshake.subscribed(&streams, &sources).is_err());
        handshake.ready().expect("ready");
        assert!(handshake.event().is_err());
        handshake
            .subscribed(&streams, &sources)
            .expect("subscribed");
        handshake.event().expect("event after confirmation");
        assert!(handshake.subscribed(&streams, &sources).is_err());
        assert!(handshake.ready().is_err());
    }

    #[test]
    fn rejects_subscription_confirmation_mismatch() {
        let sources = sources();
        for streams in [
            subscribed_streams(&sources_for(&[9])),
            vec![SubscribedStream {
                cursors: None,
                domains: Some(vec![5]),
                event_type: DISPATCH_EVENT_TYPE.to_owned(),
            }],
            subscribed_streams(&sources).into_iter().rev().collect(),
        ] {
            let mut handshake = HandshakeState::default();
            handshake.ready().expect("ready");
            assert!(handshake.subscribed(&streams, &sources).is_err());
            assert!(!handshake.confirmed);
        }
    }

    #[test]
    fn multiplexes_live_streams_on_one_subscription() {
        let sources = sources_for(&[9, 5]);
        let message: serde_json::Value =
            serde_json::from_str(&subscription(&sources).expect("subscription should serialize"))
                .expect("subscription JSON");

        assert_eq!(
            message,
            serde_json::json!({
                "streams": [
                    {
                        "cursors": [
                            { "address": format!("{:#x}", H256::from_low_u64_be(1)), "allowReplay": true, "domain": 5 },
                            { "address": format!("{:#x}", H256::from_low_u64_be(1)), "allowReplay": true, "domain": 9 }
                        ],
                        "domains": [5, 9],
                        "eventType": "dispatch"
                    },
                    {
                        "cursors": [
                            { "address": format!("{:#x}", H256::from_low_u64_be(2)), "allowReplay": true, "domain": 5 },
                            { "address": format!("{:#x}", H256::from_low_u64_be(2)), "allowReplay": true, "domain": 9 }
                        ],
                        "domains": [5, 9],
                        "eventType": "merkle_tree_insertion"
                    }
                ],
                "type": "subscribe"
            })
        );
    }
}
