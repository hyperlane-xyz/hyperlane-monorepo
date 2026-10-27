//! Consume scraper-proxy events with sequence/payload checks, durable writes/cursors
//! and RPC takeover/fallback. Filtering, replay and backpressure live on the server
//! (`live/agent-subscription.ts`).

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use eyre::{bail, ensure, Context, ContextCompat, Result};
use futures_util::{stream, stream::BoxStream, StreamExt};
use hyperlane_base::{
    broadcast::{BroadcastMpscSender, IndexingNotification},
    cursors::Indexable,
    db::{HyperlaneDb, HyperlaneRocksDB},
    scraper_websocket::{
        format_address, parse_address, reconnect_after, EventMessage, GasPaymentCursor,
        MerkleEventData, RejectedStream, ScraperSession, SequenceCursor, ServerMessage,
        SessionEvent, StreamCursor, StreamHealth, StreamTimeouts, StringOrNumber, SubscribeMessage,
        SubscribeStream, RETRY_DELAY, RPC_PROBE_TIMEOUT,
    },
    settings::SequenceIndexer,
    ContractSyncMetrics, CoreMetrics,
};
use hyperlane_core::{
    bytes_to_h512, Decode, Encode, HyperlaneMessage, HyperlaneProtocolError, Indexed,
    InterchainGasPayment, LogMeta, MerkleTreeInsertion, H256, H512, U256,
};
use prometheus::{IntCounterVec, IntGaugeVec};
use serde::Deserialize;
use tokio::{
    sync::{watch, Notify},
    time::{timeout, Instant},
};
use tracing::{info, warn};
use url::Url;

const GAS_CURSOR_VERSION: u32 = 3;
const HANDOFF_TIMEOUT: Duration = Duration::from_secs(30);
const ACTIVE_PROBE_INTERVAL: Duration = Duration::from_secs(120);
// Preserve deployed cursor keys and encoding so upgrades resume existing replay.
const DISPATCH_CURSOR: &[u8] = b"scraper_websocket_dispatch_cursor";
const MERKLE_CURSOR: &[u8] = b"scraper_websocket_merkle_cursor";
const GAS_CURSOR: &[u8] = b"scraper_websocket_gas_payment_cursor";

#[derive(Clone, Copy, Debug)]
enum Kind {
    Dispatch,
    Merkle,
    Gas,
}
impl Kind {
    const ALL: [Self; 3] = [Self::Dispatch, Self::Merkle, Self::Gas];
    fn index(self) -> usize {
        self as usize
    }
    fn label(self) -> &'static str {
        match self {
            Self::Dispatch => "dispatch",
            Self::Merkle => "merkle_tree_insertion",
            Self::Gas => "gas_payment",
        }
    }
    fn parse(label: &str) -> Result<Self> {
        match label {
            "dispatch" => Ok(Self::Dispatch),
            "merkle_tree_insertion" => Ok(Self::Merkle),
            "gas_payment" => Ok(Self::Gas),
            _ => bail!("Unexpected scraper event type {label}"),
        }
    }
    fn prefix(self) -> &'static [u8] {
        match self {
            Self::Dispatch => DISPATCH_CURSOR,
            Self::Merkle => MERKLE_CURSOR,
            Self::Gas => GAS_CURSOR,
        }
    }
}

#[derive(Clone)]
pub(crate) struct ScraperSource {
    chain: String,
    domain: u32,
    mailbox: H256,
    interchain_gas_paymaster: H256,
    merkle_tree_hook: H256,
    database: HyperlaneRocksDB,
    confirmations: Option<u32>,
    broadcaster: Option<BroadcastMpscSender<IndexingNotification>>,
    freshness_indexer: Option<SequenceIndexer<HyperlaneMessage>>,
    merkle_freshness_indexer: Option<SequenceIndexer<MerkleTreeInsertion>>,
    sync_metrics: Option<Arc<ContractSyncMetrics>>,
    control: Arc<Authority>,
}
impl ScraperSource {
    pub(crate) fn new(
        chain: String,
        domain: u32,
        mailbox: H256,
        interchain_gas_paymaster: H256,
        merkle_tree_hook: H256,
        database: HyperlaneRocksDB,
        confirmations: Option<u32>,
    ) -> Self {
        Self {
            chain,
            domain,
            mailbox,
            interchain_gas_paymaster,
            merkle_tree_hook,
            database,
            confirmations,
            broadcaster: None,
            freshness_indexer: None,
            merkle_freshness_indexer: None,
            sync_metrics: None,
            control: Arc::new(Authority::new(domain)),
        }
    }
    pub(crate) fn with_broadcaster(
        mut self,
        broadcaster: Option<BroadcastMpscSender<IndexingNotification>>,
    ) -> Self {
        self.broadcaster = broadcaster;
        self
    }
    pub(crate) fn with_freshness_indexer(
        mut self,
        indexer: SequenceIndexer<HyperlaneMessage>,
    ) -> Self {
        self.freshness_indexer = Some(indexer);
        self
    }
    pub(crate) fn with_merkle_freshness_indexer(
        mut self,
        indexer: SequenceIndexer<MerkleTreeInsertion>,
    ) -> Self {
        self.merkle_freshness_indexer = Some(indexer);
        self
    }
    pub(crate) fn with_sync_metrics(mut self, metrics: Arc<ContractSyncMetrics>) -> Self {
        self.sync_metrics = Some(metrics);
        self
    }
    fn address(&self, kind: Kind) -> H256 {
        match kind {
            Kind::Dispatch => self.mailbox,
            Kind::Merkle => self.merkle_tree_hook,
            Kind::Gas => self.interchain_gas_paymaster,
        }
    }
    fn load(&self) -> Result<SourceState> {
        let mut state = SourceState::default();
        if self.confirmations.is_some() {
            return Ok(state);
        }
        for kind in [Kind::Dispatch, Kind::Merkle] {
            let last: Option<u32> = self
                .database
                .retrieve_value_by_key(kind.prefix(), &self.address(kind))?;
            state.streams[kind.index()].last = last.map(u64::from);
        }
        let gas: Option<StoredGasCursor> = self
            .database
            .retrieve_value_by_key(GAS_CURSOR, &self.interchain_gas_paymaster)?;
        let progress = &mut state.streams[Kind::Gas.index()];
        progress.last = Some(gas.as_ref().map_or(0, |cursor| cursor.stream_cursor));
        progress.legacy_max = gas.map(|cursor| cursor.legacy_max_stream_cursor);
        Ok(state)
    }
    #[cfg(test)]
    fn has_sequence(&self, kind: Kind, sequence: u32) -> Result<bool> {
        Ok(match kind {
            Kind::Dispatch => self.database.retrieve_message_by_nonce(sequence)?.is_some(),
            Kind::Merkle => self
                .database
                .retrieve_merkle_tree_insertion_by_leaf_index(&sequence)?
                .is_some(),
            Kind::Gas => unreachable!("gas replays from its durable cursor"),
        })
    }
    fn persist(&self, kind: Kind, progress: &mut Progress) -> Result<()> {
        let Some(last) = progress.last else {
            return Ok(());
        };
        if matches!(kind, Kind::Gas) {
            let cursor = StoredGasCursor {
                fingerprint: None,
                legacy_max_stream_cursor: progress
                    .legacy_max
                    .context("Missing gas legacy boundary")?,
                stream_cursor: last,
            };
            self.database.store_value_by_key(
                GAS_CURSOR,
                &self.interchain_gas_paymaster,
                &cursor,
            )?;
        } else {
            let sequence = u32::try_from(last).context("Scraper sequence exceeds u32")?;
            self.database
                .store_value_by_key(kind.prefix(), &self.address(kind), &sequence)?;
            self.update_cursor_metrics(kind, sequence, true);
        }
        Ok(())
    }
    fn update_cursor_metrics(&self, kind: Kind, sequence: u32, current: bool) {
        if let Some(metrics) = &self.sync_metrics {
            let event = if matches!(kind, Kind::Dispatch) {
                HyperlaneMessage::name()
            } else {
                MerkleTreeInsertion::name()
            };
            let cursors = &metrics.cursor_metrics;
            let max = cursors
                .cursor_max_sequence
                .with_label_values(&[event, &self.chain]);
            max.set(max.get().max(i64::from(sequence)));
            if current {
                let gauge = cursors.cursor_current_sequence.with_label_values(&[
                    event,
                    &self.chain,
                    "forward_sequenced",
                ]);
                gauge.set(gauge.get().max(i64::from(sequence)));
            }
        }
    }
    async fn store(&self, kind: Kind, data: serde_json::Value, write: bool) -> Result<()> {
        match kind {
            Kind::Dispatch => {
                let data: DispatchData = serde_json::from_value(data)?;
                let nonce = data.nonce.as_u32("dispatch nonce")?;
                let message = match data.msg_body {
                    Some(body) => HyperlaneMessage {
                        version: 3,
                        nonce,
                        origin: self.domain,
                        sender: parse_address(&data.sender)?,
                        destination: data.destination_domain,
                        recipient: parse_address(&data.recipient)?,
                        body: parse_hex(&body)?,
                    },
                    // NULL is an unknown legacy body, never an empty message.
                    None => self
                        .database
                        .retrieve_message_by_id(&parse_address(&data.msg_id)?)?
                        .context("Legacy dispatch body needs RPC backfill")?,
                };
                ensure!(
                    message.nonce == nonce && message.id() == parse_address(&data.msg_id)?,
                    "Dispatch payload does not match its nonce/message ID"
                );
                let block = data.origin_block_height.as_u64("dispatch block")?;
                let tx = parse_tx(&data.origin_tx_hash)?;
                if write {
                    ensure!(
                        self.database
                            .retrieve_message_by_nonce(nonce)?
                            .is_none_or(|existing| existing == message),
                        "Conflicting scraper dispatch"
                    );
                    self.database.store_message(&message, block)?;
                    if tx != H512::zero() {
                        self.database
                            .store_dispatched_tx_hash_by_message_id(&message.id(), &tx)?;
                        if let Some(broadcaster) = &self.broadcaster {
                            // Notifications accelerate hook indexing; RPC polling also
                            // covers them, so a slow consumer must not stall the socket.
                            match timeout(
                                Duration::from_secs(1),
                                broadcaster.send(IndexingNotification {
                                    tx_id: tx,
                                    sequences: vec![Some(nonce)],
                                }),
                            )
                            .await {
                                Ok(Ok(())) => {},
                                result => warn!(chain = self.chain, ?result, "Scraper dispatch notification failed; RPC polling remains available"),
                            }
                        }
                    }
                }
            }
            Kind::Merkle => {
                let data: MerkleEventData = serde_json::from_value(data)?;
                let sequence = data.leaf_index.as_u32("Merkle leaf index")?;
                let (insertion, block) =
                    data.decode(self.domain, self.merkle_tree_hook, sequence)?;
                if write {
                    if let Some(existing) = self
                        .database
                        .store_tree_insertion_if_absent(&insertion, block)?
                    {
                        ensure!(existing == insertion, "Conflicting scraper Merkle leaf");
                    }
                }
            }
            Kind::Gas => {
                let data: GasData = serde_json::from_value(data)?;
                let (payment, meta) = data.decode(self.interchain_gas_paymaster)?;
                if write {
                    self.database.process_indexed_gas_payment(payment, &meta)?;
                }
            }
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct AuthorityCommand {
    pub(crate) desired: bool,
    pub(crate) generation: u64,
}
struct PauseAck {
    domain: u32,
    generation: AtomicU64,
    changed: Notify,
}
struct Authority {
    command: watch::Sender<AuthorityCommand>,
    ack: Arc<PauseAck>,
    gas: watch::Sender<bool>,
}
impl Authority {
    fn new(domain: u32) -> Self {
        Self {
            command: watch::channel(AuthorityCommand {
                desired: false,
                generation: 0,
            })
            .0,
            ack: Arc::new(PauseAck {
                domain,
                generation: AtomicU64::new(0),
                changed: Notify::new(),
            }),
            gas: watch::channel(false).0,
        }
    }
    fn receiver(&self) -> ScraperAuthorityReceiver {
        ScraperAuthorityReceiver {
            desired: self.command.subscribe(),
            ack: self.ack.clone(),
        }
    }
    fn request(&self) -> u64 {
        self.command.send_if_modified(|command| {
            if command.desired {
                return false;
            }
            command.desired = true;
            command.generation = command
                .generation
                .checked_add(1)
                .expect("RPC handoff generation exhausted");
            true
        });
        self.command.borrow().generation
    }
    fn resume(&self) {
        self.command.send_if_modified(|command| {
            let changed = command.desired;
            command.desired = false;
            changed
        });
        self.set_gas(false);
    }
    fn set_gas(&self, active: bool) {
        self.gas.send_if_modified(|value| {
            let changed = *value != active;
            *value = active;
            changed
        });
    }
    async fn paused(&self, generation: u64) -> bool {
        let mut command = self.command.subscribe();
        loop {
            let notified = self.ack.changed.notified();
            let current = *command.borrow_and_update();
            if !current.desired || current.generation != generation {
                return false;
            }
            if self.ack.generation.load(Ordering::Acquire) == generation {
                return true;
            }
            tokio::select! { _ = notified => {}, result = command.changed() => { if result.is_err() { return false; } } }
        }
    }
}
#[derive(Clone)]
pub(crate) struct ScraperAuthorityReceiver {
    desired: watch::Receiver<AuthorityCommand>,
    ack: Arc<PauseAck>,
}
impl ScraperAuthorityReceiver {
    #[cfg(test)]
    pub(crate) fn test_channel(domain: u32) -> (watch::Sender<AuthorityCommand>, Self) {
        let authority = Authority::new(domain);
        (authority.command.clone(), authority.receiver())
    }
    pub(crate) fn borrow_and_update(&mut self) -> AuthorityCommand {
        *self.desired.borrow_and_update()
    }
    pub(crate) async fn changed(&mut self) -> Result<(), watch::error::RecvError> {
        self.desired.changed().await
    }
    pub(crate) fn mark_paused(&self, domain: u32, generation: u64) {
        if domain == self.ack.domain {
            self.ack.generation.store(generation, Ordering::Release);
            self.ack.changed.notify_waiters();
        }
    }
    pub(crate) fn mark_running(&self, domain: u32) {
        if domain == self.ack.domain {
            self.ack.generation.store(0, Ordering::Release);
        }
    }
}

struct Progress {
    last: Option<u64>,
    caught_up: bool,
    usable: bool,
    legacy_max: Option<u64>,
}
impl Default for Progress {
    fn default() -> Self {
        Self {
            last: None,
            caught_up: false,
            usable: true,
            legacy_max: None,
        }
    }
}
impl Progress {
    fn ready(&self) -> bool {
        self.caught_up && self.usable
    }
    fn check_gas_cursor(&self, last: u64, legacy: u64, marker: bool) -> Result<()> {
        ensure!(
            self.legacy_max.is_none_or(|known| known == legacy),
            "Gas legacy boundary changed"
        );
        let previous = self.last.unwrap_or(0);
        // Legacy IDs are sparse; a marker may cover their remaining empty tail.
        let limit = previous.max(legacy);
        ensure!(
            if marker {
                last == limit
            } else {
                last > 0 && last <= limit.saturating_add(1)
            },
            "Invalid gas cursor {last} after {previous} (legacy boundary {legacy})"
        );
        Ok(())
    }
}
#[derive(Default)]
struct SourceState {
    streams: [Progress; 3],
    health: [StreamHealth; 2],
    active: bool,
    fresh: bool,
    last_fresh: Option<Instant>,
    ahead: bool,
}
impl SourceState {
    fn ready(&self) -> bool {
        self.streams[..2].iter().all(Progress::ready)
    }
}

// The old cursor contained a duplicate fingerprint. Decode it for compatibility;
// DB log metadata deduplicates gas credits; versioned cursors detect gaps.
struct StoredGasCursor {
    fingerprint: Option<H256>,
    legacy_max_stream_cursor: u64,
    stream_cursor: u64,
}
impl Encode for StoredGasCursor {
    fn write_to<W: std::io::Write>(&self, writer: &mut W) -> std::io::Result<usize> {
        let mut count = self.fingerprint.is_some().write_to(writer)?;
        if let Some(fingerprint) = self.fingerprint {
            count = count.saturating_add(fingerprint.write_to(writer)?);
        }
        count = count.saturating_add(self.legacy_max_stream_cursor.write_to(writer)?);
        Ok(count.saturating_add(self.stream_cursor.write_to(writer)?))
    }
}
impl Decode for StoredGasCursor {
    fn read_from<R: std::io::Read>(
        reader: &mut R,
    ) -> std::result::Result<Self, HyperlaneProtocolError> {
        let fingerprint = bool::read_from(reader)?
            .then(|| H256::read_from(reader))
            .transpose()?;
        Ok(Self {
            fingerprint,
            legacy_max_stream_cursor: u64::read_from(reader)?,
            stream_cursor: u64::read_from(reader)?,
        })
    }
}

#[derive(Clone)]
struct Metrics {
    active: IntGaugeVec,
    authority: IntGaugeVec,
    caught_up: IntGaugeVec,
    fresh: IntGaugeVec,
    degraded: IntGaugeVec,
    events: IntCounterVec,
}
type Probe = (u32, [u32; 2], Result<[u32; 2]>);

pub(crate) struct ScraperWebSocketMonitor {
    sources: HashMap<u32, ScraperSource>,
    url: Url,
    authority_enabled: bool,
    metrics: Metrics,
}
// Restores RPC even when the socket task is aborted, not just on ordinary errors.
struct ConnectionGuard<'a>(&'a ScraperWebSocketMonitor);
impl Drop for ConnectionGuard<'_> {
    fn drop(&mut self) {
        self.0.reset();
    }
}

impl ScraperWebSocketMonitor {
    pub(crate) fn new_with_authority(
        url: Url,
        sources: Vec<ScraperSource>,
        metrics: &CoreMetrics,
        authority_enabled: bool,
    ) -> Result<Self> {
        let monitor = Self {
            sources: sources
                .into_iter()
                .map(|source| (source.domain, source))
                .collect(),
            url,
            authority_enabled,
            metrics: Metrics {
                active: metrics.new_int_gauge(
                    "relayer_scraper_websocket_active",
                    "Whether the scraper stream is connected",
                    &["chain"],
                )?,
                authority: metrics.new_int_gauge(
                    "relayer_scraper_websocket_authority",
                    "Whether scraper-proxy replaces RPC indexing",
                    &["chain"],
                )?,
                caught_up: metrics.new_int_gauge(
                    "relayer_scraper_websocket_caught_up",
                    "Whether scraper replay completed",
                    &["chain", "event_type"],
                )?,
                fresh: metrics.new_int_gauge(
                    "relayer_scraper_websocket_fresh",
                    "Whether scraper cursors match origin counts",
                    &["chain"],
                )?,
                degraded: metrics.new_int_gauge(
                    "relayer_scraper_websocket_degraded",
                    "Whether a stream needs RPC fallback",
                    &["chain", "event_type"],
                )?,
                events: metrics.new_int_counter(
                    "relayer_scraper_websocket_events",
                    "Scraper events consumed",
                    &["chain", "event_type", "result"],
                )?,
            },
        };
        monitor.reset();
        Ok(monitor)
    }
    pub(crate) fn authority_receiver(&self, domain: u32) -> Option<ScraperAuthorityReceiver> {
        self.authority_enabled
            .then(|| self.sources[&domain].control.receiver())
    }
    pub(crate) fn gas_payment_authority_receiver(
        &self,
        domain: u32,
    ) -> Option<watch::Receiver<bool>> {
        self.authority_enabled
            .then(|| self.sources[&domain].control.gas.subscribe())
    }
    fn reset(&self) {
        for source in self.sources.values() {
            source.control.resume();
            for gauge in [
                &self.metrics.active,
                &self.metrics.authority,
                &self.metrics.fresh,
            ] {
                gauge.with_label_values(&[source.chain.as_str()]).set(0);
            }
            for kind in Kind::ALL {
                self.metrics
                    .caught_up
                    .with_label_values(&[source.chain.as_str(), kind.label()])
                    .set(0);
                self.metrics
                    .degraded
                    .with_label_values(&[source.chain.as_str(), kind.label()])
                    .set(0);
            }
        }
    }
    fn revoke(&self, source: &ScraperSource, state: &mut SourceState) {
        source.control.resume();
        state.active = false;
        state.fresh = false;
        state.last_fresh = None;
        self.metrics
            .authority
            .with_label_values(&[source.chain.as_str()])
            .set(0);
        self.metrics
            .fresh
            .with_label_values(&[source.chain.as_str()])
            .set(0);
        for health in &mut state.health {
            health.reset();
        }
    }
    pub(crate) async fn run(self) {
        // The proxy allows one confirmation count per event type/connection.
        let mut groups: HashMap<_, HashMap<_, _>> = HashMap::new();
        for (domain, source) in self.sources {
            groups
                .entry(source.confirmations)
                .or_default()
                .insert(domain, source);
        }
        futures_util::future::join_all(groups.into_iter().map(|(confirmations, sources)| {
            Self {
                sources,
                url: self.url.clone(),
                authority_enabled: self.authority_enabled,
                metrics: self.metrics.clone(),
            }
            .run_connection(confirmations)
        }))
        .await;
    }
    async fn run_connection(self, confirmations: Option<u32>) {
        loop {
            let result = self.stream(StreamTimeouts::default(), confirmations).await;
            reconnect_after(result, RETRY_DELAY).await;
        }
    }
    fn subscription(
        &self,
        state: &HashMap<u32, SourceState>,
        gas: bool,
        confirmations: Option<u32>,
    ) -> SubscribeMessage<'static> {
        let mut sources = self.sources.values().collect::<Vec<_>>();
        sources.sort_unstable_by_key(|source| source.domain);
        let streams = Kind::ALL
            .into_iter()
            .filter(|kind| gas || !matches!(kind, Kind::Gas))
            .map(|kind| {
                let cursors = sources
                    .iter()
                    .map(|source| {
                        let last = state[&source.domain].streams[kind.index()].last;
                        match kind {
                            Kind::Gas => StreamCursor::GasPayment(GasPaymentCursor {
                                address: format_address(source.interchain_gas_paymaster),
                                after_stream_cursor: Some(last.unwrap_or(0).to_string()),
                                domain: source.domain,
                            }),
                            // Replay the saved boundary too; writes are idempotent.
                            _ => StreamCursor::Sequence(SequenceCursor {
                                address: format_address(source.address(kind)),
                                allow_replay: Some(true),
                                after_sequence: Some(
                                    last.and_then(|last| last.checked_sub(1))
                                        .map_or_else(|| "-1".to_owned(), |last| last.to_string()),
                                ),
                                domain: source.domain,
                            }),
                        }
                    })
                    .collect();
                SubscribeStream {
                    confirmations,
                    cursors: confirmations.is_none().then_some(cursors),
                    domains: Some(sources.iter().map(|source| source.domain).collect()),
                    event_type: kind.label(),
                    stream_cursor_version: matches!(kind, Kind::Gas).then_some(GAS_CURSOR_VERSION),
                }
            })
            .collect();
        SubscribeMessage {
            streams,
            message_type: "subscribe",
        }
    }
    async fn stream(&self, timeouts: StreamTimeouts, confirmations: Option<u32>) -> Result<()> {
        let _guard = ConnectionGuard(self);
        // Custom confirmations are live-only. RPC keeps indexing history and gas.
        let canonical = confirmations.is_none();
        let authority = self.authority_enabled && canonical;
        let mut state = self
            .sources
            .iter()
            .map(|(domain, source)| Ok((*domain, source.load()?)))
            .collect::<Result<HashMap<_, _>>>()?;
        let mut socket = ScraperSession::connect(&self.url, timeouts).await?;
        let mut gas = false;
        loop {
            if authority {
                for (domain, current) in &mut state {
                    let source = &self.sources[domain];
                    if !current.ready() {
                        self.revoke(source, current);
                    }
                    if current.ready() && current.fresh && !current.active {
                        let control = source.control.clone();
                        let generation = control.request();
                        socket.start_cutover(*domain, async move {
                            (
                                generation,
                                timeout(HANDOFF_TIMEOUT, control.paused(generation))
                                    .await
                                    .unwrap_or(false),
                            )
                        });
                    }
                    source.control.set_gas(
                        current.active && gas && current.streams[Kind::Gas.index()].ready(),
                    );
                }
            }
            let Some(event) = socket
                .next::<serde_json::Value>(authority, || self.probes(&state))
                .await?
            else {
                return Ok(());
            };
            match event {
                SessionEvent::Progress(probe) => self.apply_probe(&mut state, probe),
                SessionEvent::Cutover {
                    domain,
                    result: (generation, paused),
                } => {
                    let source = &self.sources[&domain];
                    let current = state.get_mut(&domain).context("Missing source state")?;
                    let command = *source.control.command.borrow();
                    if paused
                        && command
                            == (AuthorityCommand {
                                desired: true,
                                generation,
                            })
                        && current.ready()
                        && current.fresh
                    {
                        current.active = true;
                        self.metrics
                            .authority
                            .with_label_values(&[source.chain.as_str()])
                            .set(1);
                        info!(
                            chain = source.chain,
                            "Scraper replay is fresh; direct RPC indexing paused"
                        );
                    } else {
                        self.revoke(source, current);
                    }
                }
                SessionEvent::Message(message) => match message {
                    ServerMessage::Ready {
                        stream_cursor_versions,
                    } => {
                        gas = canonical
                            && stream_cursor_versions.get(Kind::Gas.label())
                                == Some(&GAS_CURSOR_VERSION);
                        for source in self.sources.values() {
                            self.metrics
                                .degraded
                                .with_label_values(&[source.chain.as_str(), Kind::Gas.label()])
                                .set(i64::from(canonical && !gas));
                        }
                        socket
                            .subscribe(self.subscription(&state, gas, confirmations))
                            .await?;
                    }
                    ServerMessage::Subscribed { .. } => {
                        for source in self.sources.values() {
                            self.metrics
                                .active
                                .with_label_values(&[source.chain.as_str()])
                                .set(1);
                        }
                    }
                    ServerMessage::Event(event) => {
                        let domain = event.domain;
                        let kind = Kind::parse(&event.event_type)?;
                        ensure!(
                            !matches!(kind, Kind::Gas) || gas,
                            "Unrequested scraper gas stream"
                        );
                        let source = self
                            .sources
                            .get(&domain)
                            .context("Unknown scraper domain")?;
                        let current = state.get_mut(&domain).context("Missing source state")?;
                        if source.confirmations.is_some() {
                            let field = if matches!(kind, Kind::Dispatch) {
                                "origin_mailbox"
                            } else {
                                "merkle_tree_hook"
                            };
                            // Live subscriptions include every contract in the domain.
                            if parse_address(
                                event.data[field]
                                    .as_str()
                                    .context("Missing event contract")?,
                            )? != source.address(kind)
                            {
                                continue;
                            }
                        }
                        if !current.streams[kind.index()].usable {
                            continue;
                        }
                        // Payload/storage errors affect this origin stream only. Later
                        // rows must not advance its cursor past an unprocessed event.
                        match self.consume(source, current, kind, event).await {
                            Ok(()) => {
                                self.metrics
                                    .events
                                    .with_label_values(&[
                                        source.chain.as_str(),
                                        kind.label(),
                                        if self.authority_enabled {
                                            "stored"
                                        } else {
                                            "shadow"
                                        },
                                    ])
                                    .inc();
                            }
                            Err(error) => {
                                warn!(
                                    chain = source.chain,
                                    event_type = kind.label(),
                                    ?error,
                                    "Scraper row needs RPC fallback"
                                );
                                current.streams[kind.index()].usable = false;
                                self.metrics
                                    .degraded
                                    .with_label_values(&[source.chain.as_str(), kind.label()])
                                    .set(1);
                                if matches!(kind, Kind::Gas) {
                                    source.control.set_gas(false);
                                } else {
                                    self.revoke(source, current);
                                }
                            }
                        }
                    }
                    ServerMessage::CaughtUp {
                        address,
                        domain,
                        event_type,
                        sequence,
                        stream_cursor,
                        legacy_max_stream_cursor,
                        ..
                    } => {
                        ensure!(canonical, "Unexpected caught-up marker on live-only stream");
                        let kind = Kind::parse(&event_type)?;
                        let source = self
                            .sources
                            .get(&domain)
                            .context("Unknown scraper domain")?;
                        ensure!(
                            parse_address(&address)? == source.address(kind),
                            "Unexpected caught-up address"
                        );
                        ensure!(
                            !matches!(kind, Kind::Gas) || gas,
                            "Unrequested scraper gas marker"
                        );
                        let current = state.get_mut(&domain).context("Missing source state")?;
                        let progress = &mut current.streams[kind.index()];
                        progress.caught_up = true;
                        if matches!(kind, Kind::Gas) {
                            ensure!(sequence.is_none(), "Gas marker includes a sequence");
                            let legacy =
                                parse_u64(legacy_max_stream_cursor, "gas legacy boundary")?;
                            let last = parse_u64(stream_cursor, "gas caught-up cursor")?;
                            progress.check_gas_cursor(last, legacy, true)?;
                            progress.legacy_max = Some(legacy);
                            progress.last = Some(last);
                        } else {
                            ensure!(
                                stream_cursor.is_none() && legacy_max_stream_cursor.is_none(),
                                "Sequenced marker includes gas cursors"
                            );
                            let last: i64 =
                                sequence.context("Missing caught-up sequence")?.parse()?;
                            ensure!(last >= -1, "Invalid caught-up sequence");
                            if let Some(previous) = progress.last {
                                ensure!(last >= 0, "Empty caught-up marker does not match cursor");
                                let last = u64::try_from(last)?;
                                ensure!(last <= previous, "Caught-up marker skipped events");
                                progress.caught_up = last == previous;
                            } else {
                                ensure!(last == -1, "Caught-up marker skipped events");
                            }
                        }
                        if self.authority_enabled && progress.usable {
                            source.persist(kind, progress)?;
                        }
                        self.metrics
                            .caught_up
                            .with_label_values(&[source.chain.as_str(), kind.label()])
                            .set(i64::from(progress.caught_up));
                    }
                    ServerMessage::Error { error } => return Err(RejectedStream(error).into()),
                    ServerMessage::Rollback => {
                        bail!("Canonical scraper history rolled back; restoring RPC indexing")
                    }
                    ServerMessage::Other => {}
                },
            }
        }
    }
    async fn consume(
        &self,
        source: &ScraperSource,
        state: &mut SourceState,
        kind: Kind,
        event: EventMessage<serde_json::Value>,
    ) -> Result<()> {
        let progress = &mut state.streams[kind.index()];
        let (last, legacy_max) = if matches!(kind, Kind::Gas) {
            ensure!(event.sequence.is_none(), "Gas event includes a sequence");
            let last = parse_u64(event.stream_cursor, "gas stream cursor")?;
            let legacy = parse_u64(event.legacy_max_stream_cursor, "gas legacy boundary")?;
            progress.check_gas_cursor(last, legacy, false)?;
            (last, Some(legacy))
        } else {
            ensure!(
                event.row_id.is_none()
                    && event.stream_cursor.is_none()
                    && event.legacy_max_stream_cursor.is_none(),
                "Sequenced event includes gas cursors"
            );
            (
                u64::from(
                    event
                        .sequence
                        .context("Missing event sequence")?
                        .parse::<u32>()?,
                ),
                None,
            )
        };
        if !matches!(kind, Kind::Gas) {
            let next = progress
                .last
                .map_or(0, |previous| previous.saturating_add(1));
            ensure!(
                last <= next || (source.confirmations.is_some() && progress.last.is_none()),
                "Scraper sequence gap: expected {next}, received {last}"
            );
            let field = if matches!(kind, Kind::Dispatch) {
                "nonce"
            } else {
                "leaf_index"
            };
            let sequence: StringOrNumber = serde_json::from_value(event.data[field].clone())?;
            ensure!(
                sequence.as_u64(field)? == last,
                "Payload sequence does not match envelope"
            );
        }
        source
            .store(kind, event.data, self.authority_enabled)
            .await?;
        progress.last = Some(progress.last.map_or(last, |previous| previous.max(last)));
        progress.legacy_max = legacy_max;
        if self.authority_enabled && source.confirmations.is_none() {
            source.persist(kind, progress)?;
        }
        Ok(())
    }
    fn probes(&self, state: &HashMap<u32, SourceState>) -> BoxStream<'static, Probe> {
        let sources = self
            .sources
            .values()
            .filter_map(|source| {
                let current = state.get(&source.domain).expect("Configured probe source");
                if !current.ready()
                    || (current.active
                        && current
                            .last_fresh
                            .is_some_and(|last| last.elapsed() < ACTIVE_PROBE_INTERVAL))
                {
                    return None;
                }
                let dispatch = source.freshness_indexer.clone()?;
                let merkle = source.merkle_freshness_indexer.clone()?;
                let next: [Option<u32>; 2] = std::array::from_fn(|index| {
                    current.streams[index]
                        .last
                        .map(|last| {
                            last.checked_add(1)
                                .and_then(|next| u32::try_from(next).ok())
                        })
                        .unwrap_or(Some(0))
                });
                Some((source.domain, next, dispatch, merkle))
            })
            .collect::<Vec<_>>();
        stream::iter(sources)
            .map(|(domain, next, dispatch, merkle)| async move {
                let result = async {
                    let next = [
                        next[0].context("Dispatch cursor exhausted")?,
                        next[1].context("Merkle cursor exhausted")?,
                    ];
                    let (dispatch, merkle) = tokio::try_join!(
                        async {
                            timeout(RPC_PROBE_TIMEOUT, dispatch.latest_sequence_count_and_tip())
                                .await
                                .context("Dispatch freshness timed out")?
                                .map_err(eyre::Report::from)
                        },
                        async {
                            timeout(RPC_PROBE_TIMEOUT, merkle.latest_sequence_count_and_tip())
                                .await
                                .context("Merkle freshness timed out")?
                                .map_err(eyre::Report::from)
                        },
                    )?;
                    Ok((
                        next,
                        [
                            dispatch.0.context("Missing dispatch sequence count")?,
                            merkle.0.context("Missing Merkle sequence count")?,
                        ],
                    ))
                }
                .await;
                match result {
                    Ok((next, counts)) => (domain, next, Ok(counts)),
                    Err(error) => (domain, [0; 2], Err(error)),
                }
            })
            .buffer_unordered(16)
            .boxed()
    }
    fn apply_probe(&self, state: &mut HashMap<u32, SourceState>, (domain, next, counts): Probe) {
        let source = &self.sources[&domain];
        let current = state.get_mut(&domain).expect("Configured probe source");
        if !current.ready() {
            self.revoke(source, current);
            return;
        }
        let (fresh, usable) = match counts {
            Ok(counts) => {
                for (kind, count) in [(Kind::Dispatch, counts[0]), (Kind::Merkle, counts[1])] {
                    if let Some(sequence) = count.checked_sub(1) {
                        source.update_cursor_metrics(kind, sequence, false);
                    }
                }
                let fresh = counts == next;
                let ahead = next.iter().zip(counts).any(|(next, count)| *next > count);
                let tolerate_ahead = current.active && ahead && !current.ahead;
                current.ahead = ahead;
                let usable = current
                    .health
                    .iter_mut()
                    .enumerate()
                    .map(|(index, health)| {
                        health
                            .observe(counts[index], next[index], current.active)
                            .unwrap_or(tolerate_ahead)
                    })
                    .fold(true, |all, usable| usable && all);
                (fresh, usable)
            }
            Err(error) => {
                warn!(
                    chain = source.chain,
                    ?error,
                    "Scraper freshness probe failed"
                );
                current.ahead = false;
                let usable = current.health.iter_mut().fold(true, |usable, health| {
                    health.observe_probe_failure() && usable
                });
                (false, current.active && usable)
            }
        };
        current.fresh = fresh;
        current.last_fresh = fresh.then(Instant::now);
        self.metrics
            .fresh
            .with_label_values(&[source.chain.as_str()])
            .set(i64::from(fresh));
        if !usable {
            self.revoke(source, current);
        }
    }
}

#[derive(Deserialize)]
struct DispatchData {
    nonce: StringOrNumber,
    sender: String,
    recipient: String,
    destination_domain: u32,
    msg_body: Option<String>,
    msg_id: String,
    origin_block_height: StringOrNumber,
    origin_tx_hash: String,
}
#[derive(Deserialize)]
struct GasData {
    destination: u32,
    gas_amount: String,
    payment: String,
    msg_id: String,
    log_index: String,
    sequence: Option<String>,
    origin_block_hash: Option<String>,
    origin_block_height: Option<String>,
    origin_tx_hash: Option<String>,
}
impl GasData {
    fn decode(self, paymaster: H256) -> Result<(Indexed<InterchainGasPayment>, LogMeta)> {
        let payment = InterchainGasPayment {
            message_id: parse_address(&self.msg_id)?,
            destination: self.destination,
            payment: U256::from_dec_str(&self.payment)?,
            gas_amount: U256::from_dec_str(&self.gas_amount)?,
        };
        let sequence = self
            .sequence
            .map(|sequence| sequence.parse::<u32>())
            .transpose()?;
        // Legacy rows without receipt metadata cannot be safely deduplicated with
        // RPC logs. Keep gas RPC running until receipt enrichment supplies it.
        let meta = LogMeta {
            address: paymaster,
            block_number: self
                .origin_block_height
                .context("Gas payment needs RPC block metadata")?
                .parse()?,
            block_hash: parse_address(
                &self
                    .origin_block_hash
                    .context("Gas payment needs RPC block hash")?,
            )?,
            transaction_id: parse_tx(
                &self
                    .origin_tx_hash
                    .context("Gas payment needs RPC transaction hash")?,
            )?,
            transaction_index: 0,
            log_index: U256::from_dec_str(&self.log_index)?,
        };
        let mut payment = Indexed::new(payment);
        payment.sequence = sequence;
        Ok((payment, meta))
    }
}
fn parse_u64(value: Option<String>, field: &str) -> Result<u64> {
    value
        .with_context(|| format!("Missing {field}"))?
        .parse()
        .with_context(|| format!("Invalid {field}"))
}
fn parse_hex(value: &str) -> Result<Vec<u8>> {
    hex::decode(
        value
            .strip_prefix("0x")
            .or_else(|| value.strip_prefix("\\x"))
            .unwrap_or(value),
    )
    .context("Invalid scraper hex")
}
fn parse_tx(value: &str) -> Result<H512> {
    let bytes = parse_hex(value)?;
    ensure!(
        matches!(bytes.len(), 32 | 64),
        "Invalid transaction hash length"
    );
    Ok(bytes_to_h512(&bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use futures_util::SinkExt;
    use hyperlane_base::db::test_utils;
    use hyperlane_core::{ChainResult, HyperlaneDomain, Indexer, SequenceAwareIndexer};
    use prometheus::Registry;
    use serde_json::{json, Value};
    use std::{
        ops::RangeInclusive,
        sync::atomic::{AtomicBool, AtomicU32},
    };
    use tokio::{
        net::{TcpListener, TcpStream},
        sync::oneshot,
    };
    use tokio_tungstenite::{accept_async, tungstenite::Message, WebSocketStream};

    #[derive(Debug)]
    struct Counts(AtomicU32, AtomicBool);
    #[async_trait]
    impl<T: Send + Sync + 'static> Indexer<T> for Counts {
        async fn fetch_logs_in_range(
            &self,
            _: RangeInclusive<u32>,
        ) -> ChainResult<Vec<(Indexed<T>, LogMeta)>> {
            unreachable!("count probes only")
        }
        async fn get_finalized_block_number(&self) -> ChainResult<u32> {
            Ok(100)
        }
    }
    #[async_trait]
    impl<T: Send + Sync + 'static> SequenceAwareIndexer<T> for Counts {
        async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
            Ok((
                self.1
                    .load(Ordering::Acquire)
                    .then(|| self.0.load(Ordering::Acquire)),
                100,
            ))
        }
    }
    struct Fixture {
        _dir: tempfile::TempDir,
        monitor: Arc<ScraperWebSocketMonitor>,
        counts: Arc<Counts>,
    }
    impl Fixture {
        fn new(url: Url, write: bool) -> Self {
            let dir = tempfile::tempdir().expect("temp DB");
            let db = test_utils::setup_db(dir.path().to_string_lossy().into_owned());
            let counts = Arc::new(Counts(AtomicU32::new(0), AtomicBool::new(true)));
            let sources = [5, 6].map(|domain| {
                let chain = format!("test{domain}");
                ScraperSource::new(
                    chain.clone(),
                    domain,
                    H256::from_low_u64_be(1),
                    H256::from_low_u64_be(3),
                    H256::from_low_u64_be(2),
                    HyperlaneRocksDB::new(&HyperlaneDomain::new_test_domain(&chain), db.clone()),
                    None,
                )
                .with_freshness_indexer(counts.clone())
                .with_merkle_freshness_indexer(counts.clone())
            });
            let metrics =
                CoreMetrics::new("scraper-rewrite", 9090, Registry::new()).expect("metrics");
            let monitor = Arc::new(
                ScraperWebSocketMonitor::new_with_authority(url, sources.to_vec(), &metrics, write)
                    .expect("monitor"),
            );
            Self {
                _dir: dir,
                monitor,
                counts,
            }
        }
        fn source(&self) -> &ScraperSource {
            &self.monitor.sources[&5]
        }
    }
    fn message(nonce: u32) -> HyperlaneMessage {
        HyperlaneMessage {
            version: 3,
            nonce,
            origin: 5,
            destination: 6,
            sender: H256::from_low_u64_be(3),
            recipient: H256::from_low_u64_be(4),
            body: vec![1, 2, 3],
        }
    }
    fn dispatch(nonce: u32) -> Value {
        let message = message(nonce);
        json!({"nonce": nonce, "origin_mailbox": format!("{:#x}", H256::from_low_u64_be(1)), "sender": format!("{:#x}", message.sender), "recipient": format!("{:#x}", message.recipient), "destination_domain": 6,
            "msg_id": format!("{:#x}", message.id()), "msg_body": "\\x010203", "origin_block_height": "100", "origin_tx_hash": format!("{:#x}", H256::from_low_u64_be(9))})
    }
    fn merkle(nonce: u32) -> Value {
        json!({"domain":5, "merkle_tree_hook":format!("{:#x}", H256::from_low_u64_be(2)), "leaf_index":nonce, "message_id":format!("{:#x}", message(nonce).id()), "block_number":"100"})
    }
    fn gas(cursor: u64) -> Value {
        json!({"destination":6, "gas_amount":"50000", "payment":"1000", "msg_id":format!("{:#x}", H256::from_low_u64_be(7)), "log_index":cursor.to_string(), "sequence":null,
            "origin_block_hash":format!("{:#x}", H256::from_low_u64_be(8)), "origin_block_height":"100", "origin_tx_hash":format!("{:#x}", H256::from_low_u64_be(9))})
    }
    fn event(kind: Kind, sequence: u64, data: Value) -> Value {
        if matches!(kind, Kind::Gas) {
            json!({"type":"event", "domain":5, "eventType":kind.label(), "streamCursor":sequence.to_string(), "legacyMaxStreamCursor":"3", "rowId":sequence.to_string(), "data":data})
        } else {
            json!({"type":"event", "domain":5, "eventType":kind.label(), "sequence":sequence.to_string(), "data":data})
        }
    }
    fn caught_up(kind: Kind, sequence: i64) -> Value {
        if matches!(kind, Kind::Gas) {
            json!({"type":"caught_up", "domain":5, "address":format_address(H256::from_low_u64_be(3)), "eventType":kind.label(), "streamCursor":sequence.to_string(), "legacyMaxStreamCursor":sequence.min(3).to_string()})
        } else {
            json!({"type":"caught_up", "domain":5, "address":format_address(H256::from_low_u64_be(if matches!(kind, Kind::Dispatch) {1} else {2})), "eventType":kind.label(), "sequence":sequence.to_string()})
        }
    }
    async fn send(socket: &mut WebSocketStream<TcpStream>, value: Value) {
        socket
            .send(Message::Text(value.to_string().into()))
            .await
            .expect("send frame");
    }
    async fn handshake(listener: &TcpListener) -> (WebSocketStream<TcpStream>, Value) {
        let (tcp, _) = listener.accept().await.expect("accept");
        let mut socket = accept_async(tcp).await.expect("WebSocket");
        send(
            &mut socket,
            json!({"type":"ready", "streamCursorVersions":{"gas_payment":3}}),
        )
        .await;
        let frame = socket.next().await.expect("subscription").expect("frame");
        let request: Value = serde_json::from_str(frame.to_text().expect("text")).expect("JSON");
        let mut response = request["streams"].clone();
        for stream in response.as_array_mut().expect("streams") {
            if let Some(cursors) = stream["cursors"].as_array_mut() {
                for cursor in cursors {
                    cursor
                        .as_object_mut()
                        .expect("cursor")
                        .remove("allowReplay");
                }
            }
        }
        send(
            &mut socket,
            json!({"type":"subscribed", "streams":response}),
        )
        .await;
        (socket, request)
    }
    async fn listener() -> (TcpListener, Url) {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
        let url =
            Url::parse(&format!("ws://{}", listener.local_addr().expect("address"))).expect("URL");
        (listener, url)
    }
    fn timeouts() -> StreamTimeouts {
        StreamTimeouts {
            progress_check: Duration::from_millis(10),
            ..StreamTimeouts::default()
        }
    }
    async fn eventually(mut condition: impl FnMut() -> bool) {
        timeout(Duration::from_secs(5), async {
            while !condition() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("condition");
    }
    fn acknowledge(source: &ScraperSource) -> tokio::task::JoinHandle<()> {
        let mut receiver = source.control.receiver();
        let domain = source.domain;
        tokio::spawn(async move {
            while receiver.changed().await.is_ok() {
                let command = receiver.borrow_and_update();
                if command.desired {
                    receiver.mark_paused(domain, command.generation);
                }
            }
        })
    }
    fn payment_total(source: &ScraperSource) -> U256 {
        let key = InterchainGasPayment {
            message_id: H256::from_low_u64_be(7),
            destination: 6,
            payment: U256::zero(),
            gas_amount: U256::zero(),
        }
        .into();
        source
            .database
            .retrieve_gas_payment_by_gas_payment_key(key)
            .expect("gas lookup")
            .map_or(U256::zero(), |payment| payment.payment)
    }

    #[tokio::test]
    async fn configured_confirmations_deliver_live_events_while_rpc_stays_enabled() {
        for confirmations in [0, 1, 3] {
            let (listener, url) = listener().await;
            let mut fixture = Fixture::new(url, true);
            for (domain, source) in &mut Arc::get_mut(&mut fixture.monitor)
                .expect("unique monitor")
                .sources
            {
                source.confirmations = Some(if *domain == 5 { confirmations } else { 3 });
            }
            let source = fixture.source().clone();
            source
                .database
                .store_value_by_key(DISPATCH_CURSOR, &source.mailbox, &2_u32)
                .expect("old canonical cursor");
            let degraded = fixture.monitor.metrics.degraded.clone();
            let monitor = Arc::into_inner(fixture.monitor).expect("unique monitor");
            let client = tokio::spawn(async move { monitor.run().await });
            timeout(Duration::from_secs(5), async {
                let mut sockets = Vec::new();
                let mut subscribed = Vec::new();
                for _ in 0..if confirmations == 3 { 1 } else { 2 } {
                    let (mut socket, request) = handshake(&listener).await;
                    let domains = request["streams"][0]["domains"]
                        .as_array()
                        .expect("domains");
                    subscribed.extend(domains.iter().cloned());
                    assert_eq!(request["streams"].as_array().expect("streams").len(), 2);
                    for stream in request["streams"].as_array().expect("streams") {
                        assert!(stream.get("cursors").is_none());
                        assert_eq!(
                            stream["confirmations"],
                            if domains.contains(&json!(5)) {
                                confirmations
                            } else {
                                3
                            }
                        );
                    }
                    if domains.contains(&json!(5)) {
                        let mut foreign = dispatch(99);
                        foreign["origin_mailbox"] = json!(format!("{:#x}", H256::zero()));
                        send(&mut socket, event(Kind::Dispatch, 99, foreign)).await;
                        for sequence in [5, 6, 8] {
                            send(
                                &mut socket,
                                event(
                                    Kind::Dispatch,
                                    sequence,
                                    dispatch(u32::try_from(sequence).expect("sequence")),
                                ),
                            )
                            .await;
                        }
                    }
                    sockets.push(socket);
                }
                assert_eq!(subscribed.len(), 2);
                assert!(subscribed.contains(&json!(5)) && subscribed.contains(&json!(6)));
                eventually(|| {
                    degraded
                        .with_label_values(&["test5", Kind::Dispatch.label()])
                        .get()
                        == 1
                })
                .await;
                for sequence in [5, 6] {
                    assert!(source
                        .has_sequence(Kind::Dispatch, sequence)
                        .expect("live message"));
                }
                for sequence in [8, 99] {
                    assert!(!source
                        .has_sequence(Kind::Dispatch, sequence)
                        .expect("rejected message"));
                }
                assert!(!source.control.command.borrow().desired);
                assert!(!*source.control.gas.borrow());
                let saved: Option<u32> = source
                    .database
                    .retrieve_value_by_key(DISPATCH_CURSOR, &source.mailbox)
                    .expect("canonical cursor");
                assert_eq!(saved, Some(2), "live streams do not persist replay cursors");
            })
            .await
            .expect("live subscriptions");
            client.abort();
            let _ = client.await;
        }
    }

    #[tokio::test]
    async fn sequenced_streams_accept_replays_but_reject_gaps_and_payload_mismatches() {
        let fixture = Fixture::new(Url::parse("ws://localhost:1").expect("URL"), true);
        for (kind, payload) in [
            (Kind::Dispatch, dispatch as fn(u32) -> Value),
            (Kind::Merkle, merkle),
        ] {
            let source = fixture.source();
            let mut state = source.load().expect("state");
            for sequence in [0, 0, 1, 0] {
                fixture
                    .monitor
                    .consume(
                        source,
                        &mut state,
                        kind,
                        serde_json::from_value(event(
                            kind,
                            sequence,
                            payload(u32::try_from(sequence).expect("sequence")),
                        ))
                        .expect("event"),
                    )
                    .await
                    .expect("contiguous event or replay");
            }
            let mut mixed = event(kind, 2, payload(2));
            mixed["rowId"] = json!("1");
            for (row, error) in [
                (event(kind, 3, payload(3)), "sequence gap"),
                (event(kind, 2, payload(3)), "Payload sequence"),
                (mixed, "includes gas cursors"),
            ] {
                let result = fixture
                    .monitor
                    .consume(
                        source,
                        &mut state,
                        kind,
                        serde_json::from_value(row).expect("event"),
                    )
                    .await;
                assert!(result
                    .expect_err("reject event")
                    .to_string()
                    .contains(error));
                assert_eq!(state.streams[kind.index()].last, Some(1));
                let saved: Option<u32> = source
                    .database
                    .retrieve_value_by_key(kind.prefix(), &source.address(kind))
                    .expect("cursor");
                assert_eq!(saved, Some(1));
                assert!(!source.has_sequence(kind, 3).expect("gap was not stored"));
            }
        }
    }

    #[tokio::test]
    async fn gas_cursor_checks_precede_writes_and_allow_sparse_legacy_replay() {
        let fixture = Fixture::new(Url::parse("ws://localhost:1").expect("URL"), true);
        let source = fixture.source();
        let mut state = source.load().expect("state");
        for cursor in [1, 3, 4, 4] {
            fixture
                .monitor
                .consume(
                    source,
                    &mut state,
                    Kind::Gas,
                    serde_json::from_value(event(Kind::Gas, cursor, gas(cursor))).expect("event"),
                )
                .await
                .expect("legacy gaps, contiguous events and duplicates");
        }
        for (cursor, field, value) in [
            (6, "legacyMaxStreamCursor", json!("3")),
            (5, "legacyMaxStreamCursor", json!("invalid")),
            (5, "legacyMaxStreamCursor", json!("4")),
            (5, "sequence", json!("5")),
        ] {
            let mut row = event(Kind::Gas, cursor, gas(cursor));
            row[field] = value;
            assert!(fixture
                .monitor
                .consume(
                    source,
                    &mut state,
                    Kind::Gas,
                    serde_json::from_value(row).expect("event"),
                )
                .await
                .is_err());
            assert_eq!(state.streams[Kind::Gas.index()].last, Some(4));
            assert_eq!(payment_total(source), U256::from(3000));
        }
        let progress = Progress {
            last: Some(1),
            legacy_max: Some(3),
            ..Progress::default()
        };
        assert!(progress.check_gas_cursor(3, 3, true).is_ok());
        assert!(progress.check_gas_cursor(4, 3, false).is_ok());
        assert_eq!(
            source.load().expect("durable cursor").streams[Kind::Gas.index()].last,
            Some(4)
        );
    }

    #[tokio::test]
    async fn conflicting_replays_preserve_existing_messages_and_leaves() {
        let fixture = Fixture::new(Url::parse("ws://localhost:1").expect("URL"), true);
        let source = fixture.source();
        for (kind, data) in [(Kind::Dispatch, dispatch(0)), (Kind::Merkle, merkle(0))] {
            source
                .store(kind, data.clone(), true)
                .await
                .expect("RPC data");
            let mut conflict = data;
            if matches!(kind, Kind::Dispatch) {
                let mut other = message(0);
                other.destination = 7;
                conflict["destination_domain"] = json!(7);
                conflict["msg_id"] = json!(format!("{:#x}", other.id()));
            } else {
                conflict["message_id"] = json!(format!("{:#x}", H256::zero()));
            }
            assert!(source
                .store(kind, conflict, true)
                .await
                .expect_err("conflict")
                .to_string()
                .contains("Conflicting"));
        }
        assert_eq!(
            source
                .database
                .retrieve_message_by_nonce(0)
                .expect("message"),
            Some(message(0))
        );
        assert_eq!(
            source
                .database
                .retrieve_merkle_tree_insertion_by_leaf_index(&0)
                .expect("leaf"),
            Some(MerkleTreeInsertion::new(0, message(0).id()))
        );
        let mut invalid = dispatch(1);
        invalid["msg_id"] = json!(format!("{:#x}", H256::zero()));
        assert!(source.store(Kind::Dispatch, invalid, true).await.is_err());
        assert!(!source
            .has_sequence(Kind::Dispatch, 1)
            .expect("invalid dispatch"));
    }

    #[tokio::test]
    async fn invalid_caught_up_markers_restore_rpc_without_advancing_the_cursor() {
        for (kind, saved, sequence, address, error) in [
            (Kind::Dispatch, Some(0_u32), 1, 1, "skipped events"),
            (Kind::Dispatch, Some(0), 0, 9, "caught-up address"),
            (Kind::Dispatch, Some(0), -1, 1, "Empty caught-up marker"),
            (Kind::Dispatch, None, 5, 1, "skipped events"),
            (Kind::Gas, Some(0), 5, 3, "Invalid gas cursor"),
            (Kind::Gas, Some(0), 3, 3, "Invalid gas cursor"),
        ] {
            let (listener, url) = listener().await;
            let fixture = Fixture::new(url, true);
            let source = fixture.source();
            if let Some(saved) = saved {
                source
                    .database
                    .store_value_by_key(DISPATCH_CURSOR, &source.mailbox, &saved)
                    .expect("saved cursor");
            }
            if matches!(kind, Kind::Gas) {
                source
                    .database
                    .store_value_by_key(
                        GAS_CURSOR,
                        &source.interchain_gas_paymaster,
                        &StoredGasCursor {
                            fingerprint: None,
                            legacy_max_stream_cursor: 3,
                            stream_cursor: 4,
                        },
                    )
                    .expect("saved gas cursor");
            }
            source.control.request();
            source.control.set_gas(true);
            let server = async {
                let (mut socket, _) = handshake(&listener).await;
                let mut marker = caught_up(kind, sequence);
                marker["address"] = json!(format_address(H256::from_low_u64_be(address)));
                send(&mut socket, marker).await;
                while socket.next().await.is_some() {}
            };
            let ((), result) = timeout(Duration::from_secs(5), async {
                tokio::join!(server, fixture.monitor.stream(timeouts(), None))
            })
            .await
            .expect("marker handling");
            assert!(result
                .expect_err("invalid marker")
                .to_string()
                .contains(error));
            assert!(!source.control.command.borrow().desired);
            assert!(!*source.control.gas.borrow());
            assert_eq!(
                source.load().expect("durable cursor").streams[kind.index()].last,
                if matches!(kind, Kind::Gas) {
                    Some(4)
                } else {
                    saved.map(u64::from)
                }
            );
        }
    }

    #[tokio::test]
    async fn replay_reconnect_and_rpc_overlap_do_not_duplicate_gas_credits() {
        let (listener, url) = listener().await;
        let fixture = Fixture::new(url, true);
        fixture.counts.0.store(1, Ordering::Release);
        let ack = acknowledge(fixture.source());
        for connection in 0..2 {
            // RPC may index the same payment before the socket does.
            fixture
                .source()
                .store(Kind::Gas, gas(3), true)
                .await
                .expect("RPC payment");
            let (release, released) = oneshot::channel();
            let server_listener = &listener;
            let server = async move {
                let (mut socket, request) = handshake(server_listener).await;
                assert_eq!(request["streams"][0]["cursors"][0]["afterSequence"], "-1");
                assert_eq!(
                    request["streams"][2]["cursors"][0]["afterStreamCursor"],
                    if connection == 0 { "0" } else { "3" }
                );
                if connection == 0 {
                    // An empty initial stream marks -1 before its first live event.
                    for kind in [Kind::Dispatch, Kind::Merkle] {
                        send(&mut socket, caught_up(kind, -1)).await;
                    }
                }
                for (kind, data) in [
                    (Kind::Dispatch, dispatch(0)),
                    (Kind::Merkle, merkle(0)),
                    (Kind::Gas, gas(3)),
                ] {
                    send(
                        &mut socket,
                        event(kind, if matches!(kind, Kind::Gas) { 3 } else { 0 }, data),
                    )
                    .await;
                }
                for kind in Kind::ALL {
                    if connection == 0 && !matches!(kind, Kind::Gas) {
                        continue;
                    }
                    send(
                        &mut socket,
                        caught_up(kind, if matches!(kind, Kind::Gas) { 3 } else { 0 }),
                    )
                    .await;
                }
                released.await.expect("release server");
                socket.close(None).await.expect("close");
            };
            let monitor = fixture.monitor.clone();
            let client = tokio::spawn(async move { monitor.stream(timeouts(), None).await });
            let assertions = async {
                eventually(|| *fixture.source().control.gas.borrow()).await;
                assert_eq!(payment_total(fixture.source()), U256::from(1000));
                assert_eq!(
                    fixture
                        .source()
                        .database
                        .retrieve_message_by_nonce(0)
                        .expect("message"),
                    Some(message(0))
                );
                assert!(fixture
                    .source()
                    .database
                    .retrieve_merkle_tree_insertion_by_leaf_index(&0)
                    .expect("leaf")
                    .is_some());
                assert!(fixture
                    .source()
                    .database
                    .retrieve_dispatched_tx_hash_by_message_id(&message(0).id())
                    .expect("tx")
                    .is_some());
                release.send(()).expect("release");
            };
            tokio::join!(server, assertions);
            assert!(
                client.await.expect("client").is_err(),
                "closed socket reconnects"
            );
            assert!(!fixture.source().control.command.borrow().desired);
            assert!(!*fixture.source().control.gas.borrow());
        }
        ack.abort();
    }

    #[tokio::test]
    async fn fresh_replay_covers_history_before_pausing_rpc() {
        let (listener, url) = listener().await;
        let fixture = Fixture::new(url, true);
        fixture.counts.0.store(6, Ordering::Release);
        // RPC backfills backwards: the newest row can arrive before the prefix.
        fixture
            .source()
            .store(Kind::Dispatch, dispatch(5), true)
            .await
            .expect("RPC tip");
        fixture
            .source()
            .store(Kind::Merkle, merkle(5), true)
            .await
            .expect("RPC tip");
        let ack = acknowledge(fixture.source());
        let (replay, replayed) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, request) = handshake(&listener).await;
            assert_eq!(request["streams"][0]["cursors"][0]["afterSequence"], "-1");
            for (kind, data) in [(Kind::Dispatch, dispatch(0)), (Kind::Merkle, merkle(0))] {
                send(&mut socket, event(kind, 0, data)).await;
            }
            replayed.await.expect("continue replay");
            for sequence in 1..=5 {
                for (kind, data) in [
                    (Kind::Dispatch, dispatch(sequence)),
                    (Kind::Merkle, merkle(sequence)),
                ] {
                    send(&mut socket, event(kind, u64::from(sequence), data)).await;
                }
            }
            for kind in Kind::ALL {
                send(
                    &mut socket,
                    caught_up(kind, if matches!(kind, Kind::Gas) { 0 } else { 5 }),
                )
                .await;
            }
            while socket.next().await.is_some() {}
        });
        let monitor = fixture.monitor.clone();
        let client = tokio::spawn(async move { monitor.stream(timeouts(), None).await });
        eventually(|| {
            fixture
                .source()
                .has_sequence(Kind::Merkle, 0)
                .expect("replayed row")
        })
        .await;
        assert!(!fixture.source().control.command.borrow().desired);
        let before: Option<u32> = fixture
            .source()
            .database
            .retrieve_value_by_key(DISPATCH_CURSOR, &fixture.source().mailbox)
            .expect("cursor");
        assert_eq!(before, Some(0), "RPC tip cannot advance the replay cursor");
        replay.send(()).expect("continue replay");
        eventually(|| *fixture.source().control.gas.borrow()).await;
        for sequence in 0..=5 {
            for kind in [Kind::Dispatch, Kind::Merkle] {
                assert!(fixture
                    .source()
                    .has_sequence(kind, sequence)
                    .expect("complete replay"));
            }
        }
        client.abort();
        let _ = client.await;
        assert!(!fixture.source().control.command.borrow().desired);
        assert!(!*fixture.source().control.gas.borrow());
        server.await.expect("server");
        ack.abort();
    }

    #[tokio::test]
    async fn unavailable_counts_cannot_mark_empty_streams_fresh() {
        let fixture = Fixture::new(Url::parse("ws://localhost:1").expect("URL"), true);
        fixture.counts.1.store(false, Ordering::Release);
        let mut state: HashMap<_, _> = fixture
            .monitor
            .sources
            .iter()
            .map(|(domain, source)| {
                let mut current = source.load().expect("state");
                for progress in &mut current.streams {
                    progress.caught_up = true;
                }
                (*domain, current)
            })
            .collect();
        let probes = fixture.monitor.probes(&state).collect::<Vec<_>>().await;
        assert_eq!(probes.len(), 2);
        for probe in probes {
            assert!(probe.2.is_err(), "unknown counts are not zero");
            fixture.monitor.apply_probe(&mut state, probe);
        }
        assert!(state
            .values()
            .all(|current| !current.fresh && !current.active));
    }

    #[tokio::test]
    async fn shadow_stream_never_writes_or_pauses_rpc() {
        let fixture = Fixture::new(Url::parse("ws://localhost:1").expect("URL"), false);
        let mut state = fixture.source().load().expect("state");
        for (kind, data) in [
            (Kind::Dispatch, dispatch(0)),
            (Kind::Merkle, merkle(0)),
            (Kind::Gas, gas(1)),
        ] {
            let event = serde_json::from_value(event(
                kind,
                if matches!(kind, Kind::Gas) { 1 } else { 0 },
                data,
            ))
            .expect("data");
            fixture
                .monitor
                .consume(fixture.source(), &mut state, kind, event)
                .await
                .expect("shadow");
        }
        assert!(fixture
            .source()
            .database
            .retrieve_message_by_nonce(0)
            .expect("message")
            .is_none());
        assert!(fixture
            .source()
            .database
            .retrieve_merkle_tree_insertion_by_leaf_index(&0)
            .expect("leaf")
            .is_none());
        assert_eq!(payment_total(fixture.source()), U256::zero());
        assert!(fixture.monitor.authority_receiver(5).is_none());
        assert!(fixture.monitor.gas_payment_authority_receiver(5).is_none());
        let cursor: Option<u32> = fixture
            .source()
            .database
            .retrieve_value_by_key(DISPATCH_CURSOR, &fixture.source().mailbox)
            .expect("shadow cursor");
        assert!(cursor.is_none());
    }

    #[tokio::test]
    async fn unresolved_gas_row_keeps_only_that_origins_gas_rpc_running() {
        let (listener, url) = listener().await;
        let fixture = Fixture::new(url, true);
        fixture.counts.0.store(1, Ordering::Release);
        let acks = [
            acknowledge(fixture.source()),
            acknowledge(&fixture.monitor.sources[&6]),
        ];
        let (release, released) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = handshake(&listener).await;
            for domain in [5, 6] {
                for kind in [Kind::Dispatch, Kind::Merkle] {
                    let mut marker = caught_up(kind, -1);
                    marker["domain"] = json!(domain);
                    send(&mut socket, marker).await;
                    let mut data = if matches!(kind, Kind::Dispatch) {
                        dispatch(0)
                    } else {
                        merkle(0)
                    };
                    if matches!(kind, Kind::Merkle) {
                        data["domain"] = json!(domain);
                    } else {
                        let mut message = message(0);
                        message.origin = domain;
                        data["msg_id"] = json!(format!("{:#x}", message.id()));
                    }
                    let mut row = event(kind, 0, data);
                    row["domain"] = json!(domain);
                    send(&mut socket, row).await;
                }
            }
            let mut invalid = gas(1);
            invalid["origin_block_height"] = Value::Null;
            send(&mut socket, event(Kind::Gas, 1, invalid)).await;
            send(&mut socket, event(Kind::Gas, 3, gas(3))).await;
            for domain in [5, 6] {
                let mut marker = caught_up(Kind::Gas, 3);
                marker["domain"] = json!(domain);
                send(&mut socket, marker).await;
            }
            released.await.expect("release");
            socket.close(None).await.expect("close");
        });
        let monitor = fixture.monitor.clone();
        let client = tokio::spawn(async move { monitor.stream(timeouts(), None).await });
        eventually(|| *fixture.monitor.sources[&6].control.gas.borrow()).await;
        assert!(
            fixture.source().control.command.borrow().desired,
            "dispatch and Merkle still take over"
        );
        assert!(!*fixture.source().control.gas.borrow());
        assert_eq!(
            payment_total(fixture.source()),
            U256::zero(),
            "later gas rows cannot skip the unresolved payment"
        );
        let saved: Option<StoredGasCursor> = fixture
            .source()
            .database
            .retrieve_value_by_key(GAS_CURSOR, &fixture.source().interchain_gas_paymaster)
            .expect("gas cursor");
        assert!(saved.is_none());
        release.send(()).expect("release");
        assert!(client.await.expect("client").is_err(), "socket closed");
        server.await.expect("server");
        for ack in acks {
            ack.abort();
        }
    }

    #[tokio::test]
    async fn legacy_bodies_are_recovered_from_rpc_and_missing_gas_metadata_fails_closed() {
        let fixture = Fixture::new(Url::parse("ws://localhost:1").expect("URL"), true);
        let mut data = dispatch(0);
        data["msg_body"] = Value::Null;
        assert!(fixture
            .source()
            .store(Kind::Dispatch, data.clone(), true)
            .await
            .is_err());
        assert!(fixture
            .source()
            .database
            .retrieve_message_by_nonce(0)
            .expect("message")
            .is_none());
        fixture
            .source()
            .store(Kind::Dispatch, dispatch(0), true)
            .await
            .expect("RPC body");
        fixture
            .source()
            .store(Kind::Dispatch, data, true)
            .await
            .expect("legacy body");
        assert_eq!(
            fixture
                .source()
                .database
                .retrieve_message_by_nonce(0)
                .expect("message"),
            Some(message(0))
        );
        let mut data = gas(1);
        data["origin_block_height"] = Value::Null;
        assert!(fixture.source().store(Kind::Gas, data, true).await.is_err());
        assert_eq!(payment_total(fixture.source()), U256::zero());
    }

    #[test]
    fn deployed_gas_cursors_and_sequence_boundaries_remain_compatible() {
        let fixture = Fixture::new(Url::parse("ws://localhost:1").expect("URL"), true);
        let old = StoredGasCursor {
            fingerprint: Some(H256::from_low_u64_be(99)),
            legacy_max_stream_cursor: 500,
            stream_cursor: 503,
        };
        fixture
            .source()
            .database
            .store_value_by_key(GAS_CURSOR, &fixture.source().interchain_gas_paymaster, &old)
            .expect("old cursor");
        fixture
            .source()
            .database
            .store_value_by_key(DISPATCH_CURSOR, &fixture.source().mailbox, &7u32)
            .expect("old dispatch cursor");
        let state = fixture
            .monitor
            .sources
            .iter()
            .map(|(domain, source)| (*domain, source.load().expect("state")))
            .collect();
        let request = fixture.monitor.subscription(&state, true, None);
        let cursors = request.confirmation();
        assert_eq!(
            cursors[0].cursors.as_ref().expect("dispatch cursors")[0]
                .after_sequence
                .as_deref(),
            Some("6")
        );
        assert_eq!(
            cursors[2].cursors.as_ref().expect("gas cursors")[0]
                .after_stream_cursor
                .as_deref(),
            Some("503")
        );
    }

    #[tokio::test(start_paused = true)]
    async fn stale_source_restores_rpc_without_affecting_its_peer() {
        let fixture = Fixture::new(Url::parse("ws://localhost:1").expect("URL"), true);
        let mut state: HashMap<_, _> = fixture
            .monitor
            .sources
            .iter()
            .map(|(domain, source)| (*domain, source.load().expect("state")))
            .collect();
        for (domain, current) in &mut state {
            for progress in &mut current.streams {
                progress.caught_up = true;
            }
            current.active = true;
            current.health = std::array::from_fn(|_| StreamHealth::new(Duration::from_secs(10)));
            fixture.monitor.sources[domain].control.request();
            fixture.monitor.sources[domain].control.set_gas(true);
        }
        fixture
            .monitor
            .apply_probe(&mut state, (5, [0, 0], Ok([1, 0])));
        assert!(state[&5].active, "transient lag retains authority");
        tokio::time::advance(Duration::from_secs(11)).await;
        fixture
            .monitor
            .apply_probe(&mut state, (5, [0, 0], Ok([1, 0])));
        assert!(!state[&5].active);
        assert!(!*fixture.source().control.gas.borrow());
        assert!(state[&6].active);
        assert!(*fixture.monitor.sources[&6].control.gas.borrow());
    }

    #[tokio::test]
    async fn pause_acknowledgements_are_bound_to_the_source_and_generation() {
        let authority = Authority::new(5);
        let receiver = authority.receiver();
        let generation = authority.request();
        receiver.mark_paused(6, generation);
        assert!(
            timeout(Duration::from_millis(10), authority.paused(generation))
                .await
                .is_err()
        );
        receiver.mark_paused(5, generation);
        assert!(authority.paused(generation).await);
        authority.resume();
        let next = authority.request();
        assert_ne!(next, generation);
        assert!(timeout(Duration::from_millis(10), authority.paused(next))
            .await
            .is_err());
        authority.resume();
        assert!(!authority.paused(next).await);
    }
}
