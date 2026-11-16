//! Live scraper input with RPC history recovery and a checkpoint-based acknowledged cutover.
mod events;
mod rpc;
#[cfg(test)]
mod tests;

use crate::relayer::origin::Origin;
use events::LiveEvent;
use eyre::{bail, ensure, Context, ContextCompat, Result};
use futures_util::{stream, StreamExt};
use hyperlane_base::{
    broadcast::{BroadcastMpscSender, IndexingNotification},
    db::HyperlaneRocksDB,
    scraper_websocket::{
        parse_address, reconnect_after, LiveStartBoundary, RejectedStream, ScraperSession,
        ServerMessage, SessionEvent, StreamHealth, StreamTimeouts, SubscribeMessage,
        SubscribeStream,
    },
    settings::SequenceIndexer,
    ContractSyncMetrics, CoreMetrics,
};
use hyperlane_core::{HyperlaneMessage, HyperlaneProvider, MerkleTreeInsertion, H256};
use prometheus::IntGaugeVec;
use rpc::Authority;
pub(crate) use rpc::{AuthorityCommand, RpcRecovery, ScraperAuthorityReceiver};
use std::{
    collections::{HashMap, VecDeque},
    sync::Arc,
    time::Duration,
};
use tokio::time::{sleep_until, timeout, Instant};
use tracing::{info, warn};
use url::Url;

const MAX_HANDOFF_EVENTS: usize = 4096;
const MAX_HANDOFF_BYTES: usize = 16 * 1024 * 1024;
const HANDOFF_POLL: Duration = Duration::from_secs(1);
const RPC_TIMEOUT: Duration = Duration::from_secs(30);
const HEALTH_POLL: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
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
}

#[derive(Clone)]
pub(crate) struct ScraperSource {
    chain: String,
    domain: u32,
    mailbox: H256,
    merkle_tree_hook: H256,
    interchain_gas_paymaster: H256,
    database: HyperlaneRocksDB,
    broadcaster: Option<BroadcastMpscSender<IndexingNotification>>,
    provider: Arc<dyn HyperlaneProvider>,
    freshness_indexer: SequenceIndexer<HyperlaneMessage>,
    merkle_freshness_indexer: SequenceIndexer<MerkleTreeInsertion>,
    sync_metrics: Arc<ContractSyncMetrics>,
    gas_indexing: bool,
    control: Arc<Authority>,
}
impl ScraperSource {
    pub(crate) fn from_origin(origin: &Origin) -> Self {
        Self {
            chain: origin.domain.name().to_owned(),
            domain: origin.domain.id(),
            mailbox: origin.chain_conf.addresses.mailbox,
            merkle_tree_hook: origin.chain_conf.addresses.merkle_tree_hook,
            interchain_gas_paymaster: origin.chain_conf.addresses.interchain_gas_paymaster,
            database: origin.database.clone(),
            broadcaster: origin.message_sync.get_broadcaster(),
            provider: origin.validator_announce.provider().into(),
            freshness_indexer: origin.message_sequence_indexer.clone(),
            merkle_freshness_indexer: origin.merkle_sequence_indexer.clone(),
            sync_metrics: origin.sync_metrics.clone(),
            gas_indexing: origin.igp_indexer.is_some(),
            control: Arc::new(Authority::new(origin.domain.id())),
        }
    }
    async fn verify_boundary(&self, boundary: Boundary) -> Result<()> {
        // RPC cursor coverage enforces the confirmation policy; check the fork here.
        let block = self.provider.get_block_by_height(boundary.height).await?;
        ensure!(
            block.number == boundary.height && block.hash == boundary.hash,
            "Live-start checkpoint does not match independent RPC"
        );
        Ok(())
    }
    // Gas payments have no portable on-chain sequence count, so these probes
    // cannot detect a gas-only stream stall after cutover.
    async fn counts(&self) -> Result<[u32; 2]> {
        let (dispatch, merkle) = tokio::try_join!(
            self.freshness_indexer.latest_sequence_count_and_tip(),
            self.merkle_freshness_indexer
                .latest_sequence_count_and_tip(),
        )?;
        Ok([
            dispatch.0.context("Missing mailbox count")?,
            merkle.0.context("Missing Merkle count")?,
        ])
    }
}

#[derive(Clone, Copy, Debug)]
struct Boundary {
    height: u64,
    hash: H256,
}

enum RpcProbe {
    BoundaryVerified,
    Health(HealthProbe),
}

struct HealthProbe {
    counts: [u32; 2],
    observed: [u32; 2],
}

pub(crate) struct ScraperWebSocketMonitor {
    sources: HashMap<u32, ScraperSource>,
    url: Url,
    active: IntGaugeVec,
    authority: IntGaugeVec,
}
impl ScraperWebSocketMonitor {
    pub(crate) fn new(
        url: Url,
        sources: Vec<ScraperSource>,
        metrics: &CoreMetrics,
    ) -> Result<Self> {
        let monitor = Self {
            sources: sources.into_iter().map(|s| (s.domain, s)).collect(),
            url,
            active: metrics.new_int_gauge(
                "relayer_scraper_websocket_active",
                "Whether this chain has an active scraper subscription",
                &["chain"],
            )?,
            authority: metrics.new_int_gauge(
                "relayer_scraper_websocket_authority",
                "Whether scraper replaces RPC indexing",
                &["chain"],
            )?,
        };
        for source in monitor.sources.values() {
            monitor.active.with_label_values(&[&source.chain]).set(0);
            monitor.authority.with_label_values(&[&source.chain]).set(0);
        }
        Ok(monitor)
    }
    pub(crate) fn authority_receiver(&self, domain: u32) -> Option<ScraperAuthorityReceiver> {
        self.sources
            .get(&domain)
            .map(|source| source.control.receiver())
    }
    pub(crate) async fn run(self) {
        loop {
            let result = self
                .stream(StreamTimeouts {
                    progress_check: HANDOFF_POLL,
                    ..Default::default()
                })
                .await;
            reconnect_after(result, hyperlane_base::scraper_websocket::RETRY_DELAY).await;
        }
    }
    fn subscription(&self) -> SubscribeMessage<'static> {
        SubscribeMessage {
            message_type: "subscribe",
            streams: Kind::ALL
                .into_iter()
                .filter_map(|kind| {
                    let mut domains: Vec<_> = self
                        .sources
                        .values()
                        .filter(|s| kind != Kind::Gas || s.gas_indexing)
                        .map(|s| s.domain)
                        .collect();
                    domains.sort_unstable();
                    (!domains.is_empty()).then_some(SubscribeStream {
                        event_type: kind.label(),
                        domains: Some(domains),
                        // Canonical events use each chain's standard reorg period.
                        confirmations: None,
                    })
                })
                .collect(),
        }
    }
    async fn stream(&self, timeouts: StreamTimeouts) -> Result<()> {
        let _fallback = RpcFallback(self);
        let mut states: HashMap<_, _> = self
            .sources
            .values()
            .map(|s| (s.domain, SourceState::new(s)))
            .collect();
        let mut session =
            ScraperSession::<(u32, u64, Result<Option<RpcProbe>>), (u64, bool)>::connect(
                &self.url, timeouts,
            )
            .await?;
        let mut subscribed = false;
        let mut boundary_retry = None;
        loop {
            let next = session.next::<serde_json::Value>(subscribed, || {
                // Verify each connection-scoped boundary once; keep health probes after cutover.
                let probes: Vec<_> = states
                    .values_mut()
                    .map(|state| {
                        let due = state
                            .last_probe
                            .is_none_or(|at| at.elapsed() >= HEALTH_POLL);
                        let probe = state.authoritative && due;
                        let boundary = state
                            .boundary
                            .filter(|_| !state.authoritative && !state.boundary_verified && due);
                        if probe || boundary.is_some() {
                            state.last_probe = Some(Instant::now());
                        }
                        (
                            state.source.clone(),
                            probe,
                            boundary,
                            state.next.map(|n| n.unwrap_or(0)),
                            state.source.control.generation(),
                        )
                    })
                    .collect();
                stream::iter(probes)
                    .map(
                        |(source, probe, boundary, observed, generation)| async move {
                            let result = if let Some(boundary) = boundary {
                                timeout(RPC_TIMEOUT, source.verify_boundary(boundary))
                                    .await
                                    .context("RPC boundary verification timed out")
                                    .and_then(|r| r)
                                    .map(|()| Some(RpcProbe::BoundaryVerified))
                            } else if probe {
                                timeout(RPC_TIMEOUT, source.counts())
                                    .await
                                    .context("RPC health probe timed out")
                                    .and_then(|r| r)
                                    .map(|counts| {
                                        Some(RpcProbe::Health(HealthProbe { counts, observed }))
                                    })
                            } else {
                                Ok(None)
                            };
                            (source.domain, generation, result)
                        },
                    )
                    .buffer_unordered(8)
                    .boxed()
            });
            let event = tokio::select! {
            event = next => event?,
            _ = sleep_until(boundary_retry.unwrap_or_else(Instant::now)), if boundary_retry.is_some() => {
                info!("Refreshing unavailable live-start checkpoints with a new subscription");
                return Ok(());
            }
            };
            let Some(event) = event else {
                return Ok(());
            };
            match event {
                SessionEvent::Message(ServerMessage::Ready) => {
                    session.subscribe(self.subscription()).await?;
                }
                SessionEvent::Message(ServerMessage::Subscribed { .. }) => {
                    subscribed = true;
                    for source in self.sources.values() {
                        self.active.with_label_values(&[&source.chain]).set(1);
                    }
                    info!("Subscribed to canonical live scraper events; RPC fills history");
                }
                SessionEvent::Message(ServerMessage::LiveStart(boundary)) => {
                    ensure!(subscribed, "Boundary before subscription acknowledgement");
                    let domain = boundary.domain;
                    ensure!(
                        self.sources.contains_key(&domain),
                        "Unexpected boundary domain"
                    );
                    let Some(state) = states.get_mut(&domain) else {
                        continue;
                    };
                    if let Err(error) = state.accept_boundary(boundary) {
                        self.fallback(&mut states, domain, error);
                    }
                }
                SessionEvent::Message(ServerMessage::LiveStartUnavailable { domain }) => {
                    ensure!(
                        self.sources.contains_key(&domain),
                        "Unexpected unavailable domain"
                    );
                    self.fallback(&mut states, domain, "Live-start checkpoint unavailable");
                    // The proxy only sends boundaries at subscription time. Keep
                    // healthy origins live until a bounded shared refresh is due.
                    boundary_retry.get_or_insert_with(|| {
                        Instant::now()
                            .checked_add(timeouts.progress_grace)
                            .expect("bounded boundary retry")
                    });
                }
                SessionEvent::Message(ServerMessage::Event(event)) => {
                    ensure!(subscribed, "Event before subscription acknowledgement");
                    ensure!(
                        self.sources.contains_key(&event.domain),
                        "Unexpected event domain"
                    );
                    let Some(state) = states.get_mut(&event.domain) else {
                        continue;
                    };
                    let domain = event.domain;
                    let result =
                        LiveEvent::decode(event, state.source).and_then(|event| match event {
                            Some(event) => state.ingest(event),
                            None => Ok(()),
                        });
                    if let Err(error) = result {
                        self.fallback(&mut states, domain, error);
                    }
                }
                SessionEvent::Progress((domain, generation, result)) => {
                    let Some(state) = states.get_mut(&domain) else {
                        continue;
                    };
                    if let Err(error) = state.observe_probe(generation, result) {
                        self.fallback(&mut states, domain, error);
                        continue;
                    }
                    if !state.authoritative
                        && !state.source.control.desired()
                        && state.handoff_sequences().is_some()
                    {
                        let control = state.source.control.clone();
                        let expected = control.generation();
                        session.start_cutover(domain, async move {
                            let Some(generation) = control.request(expected) else {
                                return (expected, false);
                            };
                            (
                                generation,
                                timeout(RPC_TIMEOUT, control.paused(generation))
                                    .await
                                    .unwrap_or(false),
                            )
                        });
                    }
                }
                SessionEvent::Cutover {
                    domain,
                    result: (generation, paused),
                } => {
                    let Some(state) = states.get_mut(&domain) else {
                        continue;
                    };
                    if !state.source.control.current(generation) {
                        continue;
                    }
                    let result = if paused {
                        state.finish_handoff()
                    } else {
                        Err(eyre::eyre!("RPC pause timed out"))
                    };
                    if let Err(error) = result {
                        self.fallback(&mut states, domain, error);
                        continue;
                    }
                    self.authority
                        .with_label_values(&[&state.source.chain])
                        .set(1);
                    info!(
                        chain = state.source.chain,
                        "Live-start checkpoint verified; live scraper indexing is authoritative"
                    );
                }
                SessionEvent::Message(ServerMessage::Rollback) => {
                    bail!("Scraper rolled back; restoring RPC indexing")
                }
                SessionEvent::Message(ServerMessage::Error { error }) => {
                    return Err(RejectedStream(error).into());
                }
                SessionEvent::Message(ServerMessage::Other) => {}
            }
        }
    }

    fn fallback(
        &self,
        states: &mut HashMap<u32, SourceState<'_>>,
        domain: u32,
        error: impl std::fmt::Debug,
    ) {
        if let Some(state) = states.remove(&domain) {
            state.source.control.resume();
            self.active.with_label_values(&[&state.source.chain]).set(0);
            self.authority
                .with_label_values(&[&state.source.chain])
                .set(0);
            warn!(
                chain = state.source.chain,
                ?error,
                "Scraper origin failed; retaining RPC indexing"
            );
        }
    }
}

struct SourceState<'a> {
    source: &'a ScraperSource,
    started: Instant,
    last_probe: Option<Instant>,
    boundary: Option<Boundary>,
    boundary_verified: bool,
    next: [Option<u32>; 2],
    pending: VecDeque<LiveEvent>,
    bytes: usize,
    authoritative: bool,
    health: [StreamHealth; 2],
}
impl<'a> SourceState<'a> {
    fn new(source: &'a ScraperSource) -> Self {
        Self {
            source,
            started: Instant::now(),
            last_probe: None,
            boundary: None,
            boundary_verified: false,
            next: [None, None],
            pending: VecDeque::new(),
            bytes: 0,
            authoritative: false,
            health: [StreamHealth::default(), StreamHealth::default()],
        }
    }
    fn observe_probe(&mut self, generation: u64, result: Result<Option<RpcProbe>>) -> Result<()> {
        if self.source.control.generation() != generation {
            return Ok(());
        }
        if !self.authoritative {
            match result {
                Ok(Some(RpcProbe::BoundaryVerified)) => {
                    self.boundary_verified = true;
                    for health in &mut self.health {
                        health.reset();
                    }
                }
                Err(error) => {
                    if !self.health[0].observe_probe_failure() {
                        return Err(error)
                            .context("Live-start verification failures exceeded grace period");
                    }
                    warn!(
                        chain = self.source.chain,
                        ?error,
                        "Live-start checkpoint not verified; retaining RPC indexing"
                    );
                }
                _ => {}
            }
            return Ok(());
        }
        if !self.source.control.current(generation) {
            return Ok(());
        }
        let probe = match result {
            Ok(Some(RpcProbe::Health(probe))) => probe,
            Ok(Some(RpcProbe::BoundaryVerified)) => return Ok(()),
            Ok(None) => return Ok(()),
            Err(error) => {
                if self
                    .health
                    .iter_mut()
                    .all(StreamHealth::observe_probe_failure)
                {
                    warn!(
                        chain = self.source.chain,
                        ?error,
                        "RPC probe failed; retaining live indexing during grace period"
                    );
                    return Ok(());
                }
                return Err(error).context("RPC probe failures exceeded grace period");
            }
        };
        for (i, count) in probe.counts.into_iter().enumerate() {
            if count < probe.observed[i] {
                ensure!(
                    self.health[i].observe_probe_failure(),
                    "Live scraper remained ahead of canonical count"
                );
            } else {
                self.health[i].observe(count, self.next[i].unwrap_or(0))?;
            }
        }
        Ok(())
    }
    fn ingest(&mut self, event: LiveEvent) -> Result<()> {
        if let Some((kind, sequence)) = event.sequence() {
            let index = kind.index();
            if let Some(next) = self.next[index] {
                ensure!(sequence <= next, "Live scraper sequence gap");
                if sequence < next {
                    if let Some(previous) = self
                        .pending
                        .iter()
                        .find(|e| e.sequence() == Some((kind, sequence)))
                    {
                        ensure!(previous == &event, "Conflicting buffered event");
                    } else {
                        ensure!(
                            event.matches(&self.source.database)?,
                            "Unknown duplicate event"
                        );
                    }
                    return Ok(());
                }
            }
            self.next[index] = Some(sequence.checked_add(1).context("Sequence overflow")?);
        }
        if self.authoritative {
            return self.source.store(&event);
        }
        self.bytes = self.bytes.saturating_add(event.body_bytes());
        ensure!(
            self.pending.len() < MAX_HANDOFF_EVENTS && self.bytes <= MAX_HANDOFF_BYTES,
            "Live handoff buffer full; RPC must catch up"
        );
        self.pending.push_back(event);
        Ok(())
    }
    fn accept_boundary(&mut self, wire: LiveStartBoundary) -> Result<()> {
        ensure!(
            wire.confirmations.is_none(),
            "Expected canonical live-start boundary"
        );
        ensure!(
            self.boundary.is_none() && !self.authoritative,
            "Duplicate live-start boundary"
        );
        let mut seen = [false; 3];
        for stream in wire.streams {
            let (kind, address) = match stream.event_type.as_str() {
                "dispatch" => (Kind::Dispatch, self.source.mailbox),
                "merkle_tree_insertion" => (Kind::Merkle, self.source.merkle_tree_hook),
                "gas_payment" => (Kind::Gas, self.source.interchain_gas_paymaster),
                _ => bail!("Unexpected live-start event type"),
            };
            ensure!(!seen[kind.index()], "Duplicate live-start stream");
            ensure!(
                parse_address(&stream.address)? == address,
                "Live-start contract mismatch"
            );
            seen[kind.index()] = true;
        }
        ensure!(
            seen == [true, true, self.source.gas_indexing],
            "Incomplete live-start streams"
        );
        self.boundary = Some(Boundary {
            height: wire.height.parse()?,
            hash: parse_address(&wire.hash)?,
        });
        Ok(())
    }
    fn handoff_sequences(&self) -> Option<[u32; 2]> {
        let boundary = self.boundary.filter(|_| self.boundary_verified)?;
        self.source.control.recovered_sequences(
            self.started,
            boundary.height,
            self.source.gas_indexing,
        )
    }
    fn finish_handoff(&mut self) -> Result<()> {
        // These positions include RPC's configured floor, even if its local
        // history contains no events. Recheck coverage after RPC has joined.
        self.next = self
            .handoff_sequences()
            .context("RPC boundary coverage changed during handoff")?
            .map(Some);
        self.authoritative = true;
        while let Some(event) = self.pending.pop_front() {
            self.ingest(event)?;
        }
        self.bytes = 0;
        Ok(())
    }
}
struct RpcFallback<'a>(&'a ScraperWebSocketMonitor);
impl Drop for RpcFallback<'_> {
    fn drop(&mut self) {
        for source in self.0.sources.values() {
            source.control.resume();
            self.0.active.with_label_values(&[&source.chain]).set(0);
            self.0.authority.with_label_values(&[&source.chain]).set(0);
        }
    }
}
