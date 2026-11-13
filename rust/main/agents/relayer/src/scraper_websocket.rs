//! Live scraper input with RPC history recovery and an acknowledged overlap cutover.
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
        reconnect_after, RejectedStream, ScraperSession, ServerMessage, SessionEvent, StreamHealth,
        StreamTimeouts, SubscribeMessage, SubscribeStream,
    },
    settings::SequenceIndexer,
    ContractSyncMetrics, CoreMetrics,
};
use hyperlane_core::{HyperlaneMessage, Indexer, InterchainGasPayment, MerkleTreeInsertion, H256};
use prometheus::IntGaugeVec;
use rpc::Authority;
pub(crate) use rpc::{AuthorityCommand, RpcRecovery, ScraperAuthorityReceiver};
use std::{
    collections::{HashMap, VecDeque},
    sync::Arc,
    time::Duration,
};
use tokio::time::{timeout, Instant};
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
    freshness_indexer: SequenceIndexer<HyperlaneMessage>,
    merkle_freshness_indexer: SequenceIndexer<MerkleTreeInsertion>,
    sync_metrics: Arc<ContractSyncMetrics>,
    gas_indexer: Option<Arc<dyn Indexer<InterchainGasPayment>>>,
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
            freshness_indexer: origin.message_sequence_indexer.clone(),
            merkle_freshness_indexer: origin.merkle_sequence_indexer.clone(),
            sync_metrics: origin.sync_metrics.clone(),
            gas_indexer: origin.igp_indexer.clone(),
            control: Arc::new(Authority::new(origin.domain.id())),
        }
    }
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

enum RpcProbe {
    GasBoundary(u32),
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
                "Whether the scraper stream is connected",
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
                        .filter(|s| kind != Kind::Gas || s.gas_indexer.is_some())
                        .map(|s| s.domain)
                        .collect();
                    domains.sort_unstable();
                    (!domains.is_empty()).then_some(SubscribeStream {
                        event_type: kind.label(),
                        domains: Some(domains),
                        // Canonical events use each chain's standard reorg period.
                        confirmations: None,
                        cursors: None,
                        stream_cursor_version: None,
                    })
                })
                .collect(),
        }
    }
    fn fallback(&self, state: &mut SourceState<'_>, error: eyre::Report) {
        warn!(
            chain = state.source.chain,
            ?error,
            "Origin stream unavailable; restoring RPC indexing"
        );
        state.source.control.resume();
        self.authority
            .with_label_values(&[&state.source.chain])
            .set(0);
        *state = SourceState::new(state.source);
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
        while let Some(event) = session
            .next::<serde_json::Value>(subscribed, || {
                // Sample the gas boundary once after subscription (and each fallback).
                // Then handoff uses local progress; established streams get health probes.
                let probes: Vec<_> = states
                    .values_mut()
                    .map(|state| {
                        let probe = state.authoritative
                            && state
                                .last_probe
                                .is_none_or(|at| at.elapsed() >= HEALTH_POLL);
                        if probe {
                            state.last_probe = Some(Instant::now());
                        }
                        let gas = state
                            .source
                            .gas_indexer
                            .clone()
                            .filter(|_| !state.authoritative && state.gas_boundary.is_none());
                        (
                            state.source.clone(),
                            probe,
                            gas,
                            state.next.map(|n| n.unwrap_or(0)),
                            state.source.control.generation(),
                        )
                    })
                    .collect();
                stream::iter(probes)
                    .map(|(source, probe, gas, observed, generation)| async move {
                        let result = if let Some(indexer) = gas {
                            timeout(RPC_TIMEOUT, indexer.get_finalized_block_number())
                                .await
                                .context("RPC gas boundary read timed out")
                                .and_then(|r| r.map_err(Into::into))
                                .map(|block| Some(RpcProbe::GasBoundary(block)))
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
                    })
                    .buffer_unordered(8)
                    .boxed()
            })
            .await?
        {
            match event {
                SessionEvent::Message(ServerMessage::Ready { .. }) => {
                    session.subscribe(self.subscription()).await?;
                }
                SessionEvent::Message(ServerMessage::Subscribed { .. }) => {
                    subscribed = true;
                    for source in self.sources.values() {
                        self.active.with_label_values(&[&source.chain]).set(1);
                    }
                    info!("Subscribed to canonical live scraper events; RPC fills history");
                }
                SessionEvent::Message(ServerMessage::Event(event)) => {
                    ensure!(subscribed, "Event before subscription acknowledgement");
                    let state = states
                        .get_mut(&event.domain)
                        .context("Unexpected event domain")?;
                    let result =
                        LiveEvent::decode(event, state.source).and_then(|event| match event {
                            Some(event) => state.ingest(event),
                            None => Ok(()),
                        });
                    if let Err(error) = result {
                        self.fallback(state, error);
                    }
                }
                SessionEvent::Progress((domain, generation, result)) => {
                    let state = states.get_mut(&domain).context("Unexpected probe domain")?;
                    let result = state.observe_probe(generation, result).and_then(|()| {
                        if !state.authoritative && !state.source.control.desired() {
                            state.overlap_ready()
                        } else {
                            Ok(false)
                        }
                    });
                    match result {
                        Ok(true) => {
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
                        Ok(false) => {}
                        Err(error) => self.fallback(state, error),
                    }
                }
                SessionEvent::Cutover {
                    domain,
                    result: (generation, paused),
                } => {
                    let state = states
                        .get_mut(&domain)
                        .context("Unexpected cutover domain")?;
                    if !state.source.control.current(generation) {
                        continue;
                    }
                    let result = if paused {
                        state.finish_handoff()
                    } else {
                        Err(eyre::eyre!("RPC pause timed out"))
                    };
                    match result {
                        Ok(()) => {
                            self.authority
                                .with_label_values(&[&state.source.chain])
                                .set(1);
                            info!(
                                chain = state.source.chain,
                                "RPC overlap verified; live scraper indexing is authoritative"
                            );
                        }
                        Err(error) => self.fallback(state, error),
                    }
                }
                SessionEvent::Message(ServerMessage::Rollback) => {
                    bail!("Scraper rolled back; restoring RPC indexing")
                }
                SessionEvent::Message(ServerMessage::Error { error }) => {
                    return Err(RejectedStream(error).into());
                }
                // No cursors were requested, so replay markers cannot authorize a handoff.
                SessionEvent::Message(ServerMessage::CaughtUp { .. } | ServerMessage::Other) => {}
            }
        }
        Ok(())
    }
}

struct SourceState<'a> {
    source: &'a ScraperSource,
    started: Instant,
    last_probe: Option<Instant>,
    // Fixed canonical height sampled after the live subscription starts.
    gas_boundary: Option<u32>,
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
            gas_boundary: None,
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
                Ok(Some(RpcProbe::GasBoundary(block))) => {
                    self.gas_boundary.get_or_insert(block);
                }
                Err(error) => warn!(
                    chain = self.source.chain,
                    ?error,
                    "Gas boundary unavailable; retaining RPC indexing"
                ),
                _ => {}
            }
            return Ok(());
        }
        if !self.source.control.current(generation) {
            return Ok(());
        }
        let probe = match result {
            Ok(Some(RpcProbe::Health(probe))) => probe,
            Ok(Some(RpcProbe::GasBoundary(_))) => return Ok(()),
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
                self.health[i].observe(count, self.next[i].unwrap_or(0), false)?;
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
    fn overlap_ready(&self) -> Result<bool> {
        // The first events stay buffered until handoff; no duplicate anchor copies.
        let dispatch = self
            .pending
            .iter()
            .find(|event| matches!(event, LiveEvent::Dispatch(..)));
        let merkle = self
            .pending
            .iter()
            .find(|event| matches!(event, LiveEvent::Merkle(..)));
        let (Some(dispatch), Some(merkle)) = (dispatch, merkle) else {
            return Ok(false);
        };
        if !dispatch.matches(&self.source.database)? || !merkle.matches(&self.source.database)? {
            return Ok(false);
        }
        let block = dispatch.block().max(merkle.block());
        if self.source.gas_indexer.is_some() && self.gas_boundary.is_none() {
            return Ok(false);
        }
        Ok(self
            .source
            .control
            .history_ready(self.started, block, self.gas_boundary))
    }
    fn finish_handoff(&mut self) -> Result<()> {
        // RPC is joined before socket writes begin. Recheck the fixed overlap;
        // later RPC writes are deduplicated while draining the live tail.
        ensure!(self.overlap_ready()?, "RPC overlap changed during handoff");
        while let Some(event) = self.pending.pop_front() {
            self.source.store(&event)?;
        }
        self.bytes = 0;
        self.authoritative = true;
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
