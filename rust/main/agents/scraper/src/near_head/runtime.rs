//! One state writer per chain. RPC work remains asynchronous, but observation,
//! publication and ingestion never contend for the same `scraper_head` row.
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use futures::FutureExt;
use hyperlane_base::{ChainMetrics, ContractSyncMetrics};
use hyperlane_core::{HyperlaneDomain, ReorgPeriod};
use tokio::{
    sync::{mpsc, watch, Mutex, Notify},
    time::{interval, sleep, sleep_until, Instant, Interval, MissedTickBehavior},
};
use tracing::{debug, warn};

use super::{
    pipeline::{confirm_leased_through, confirmation_lease, ingest_cached, observe, CountCache},
    source::{Header, Source},
    store::{State, Store},
};

pub(super) struct Worker {
    pub source: Box<dyn Source>,
    pub store: Store,
    pub domain: HyperlaneDomain,
    pub period: ReorgPeriod,
    pub chunk_size: u64,
    pub poll_interval: Duration,
    pub wakeup: Notify,
    pub wanted: AtomicU64,
    pub heads: Mutex<mpsc::Receiver<Header>>,
    pub polled_head: watch::Sender<u64>,
    pub critical_failure_grace: Duration,
    pub chain_metrics: ChainMetrics,
    pub sync_metrics: Arc<ContractSyncMetrics>,
}

#[derive(Debug, Default)]
struct FailureStreak {
    since: Option<Instant>,
}

impl FailureStreak {
    fn record(&mut self, failed: bool, grace: Duration) -> bool {
        if !failed {
            self.since = None;
            return false;
        }
        let now = Instant::now();
        let since = self.since.get_or_insert(now);
        now.duration_since(*since) >= grace
    }

    fn retry_delay(&self, poll_interval: Duration, grace: Duration) -> Duration {
        let Some(since) = self.since else {
            return poll_interval;
        };
        let remaining = grace.saturating_sub(since.elapsed());
        if remaining.is_zero() {
            poll_interval
        } else {
            poll_interval.min(remaining)
        }
    }
}

/// Header hints refresh confirmation eligibility without fetching event ranges.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Wakeup {
    Index,
    Head(Vec<Header>),
}

/// A completed cycle: whether to run again at once, and whether ingestion failed
/// while existing work still published.
#[derive(Debug)]
pub(super) struct CycleOutcome {
    pub more: bool,
    pub ingestion_failed: bool,
}

const MIN_WAKE_INTERVAL: Duration = Duration::from_secs(1);
const MIN_HEAD_INTERVAL: Duration = Duration::from_millis(200);
const RECENT_HEADERS: usize = 256;
// At 250ms/block this allows 16s of HTTP/WS skew without trusting an unbounded lead.
const MAX_HEADER_LEAD: u64 = 64;

fn remember_headers(recent: &mut VecDeque<Header>, headers: &[Header]) {
    for header in headers {
        if recent.back() == Some(header) {
            continue;
        }
        if recent.back().is_some_and(|tip| {
            tip.height.checked_add(1) != Some(header.height) || header.parent != tip.hash
        }) {
            recent.clear();
        }
        recent.push_back(header.clone());
        if recent.len() > RECENT_HEADERS {
            recent.pop_front();
        }
    }
}

fn linked_tip(recent: &VecDeque<Header>, state: &State) -> Option<Header> {
    let anchored = recent.iter().any(|header| {
        (header.height == state.indexed && header.hash == state.hash)
            || (state.indexed.checked_add(1) == Some(header.height) && header.parent == state.hash)
    });
    anchored
        .then(|| {
            recent
                .back()
                .filter(|tip| tip.height > state.indexed)
                .cloned()
        })
        .flatten()
}

impl Worker {
    pub async fn run(&self) {
        let stagger_period = u64::try_from(self.poll_interval.as_millis())
            .unwrap_or(u64::MAX)
            .max(1);
        let stagger = u64::from(self.domain.id())
            .wrapping_mul(0x9E37_79B9_7F4A_7C15)
            .checked_rem(stagger_period)
            .unwrap_or_default();
        sleep(Duration::from_millis(stagger)).await;
        self.run_cycles().await
    }

    async fn run_cycles(&self) {
        let mut count_cache = CountCache::default();
        let mut failures = FailureStreak::default();
        let mut polling = interval(self.poll_interval);
        // The first cycle below already runs immediately.
        polling.reset();
        // Event wake-ups and fetch duration must not reset the polling cadence.
        // A slow cycle needs one catch-up poll, not a burst of missed ticks.
        polling.set_missed_tick_behavior(MissedTickBehavior::Skip);
        let mut heads = self.heads.lock().await;
        let mut tip = None;
        let mut recent = VecDeque::with_capacity(RECENT_HEADERS);
        let mut wakeup = Wakeup::Index;
        let mut next_index = Instant::now();
        let mut next_head = Instant::now();
        loop {
            let result = match &wakeup {
                Wakeup::Index => {
                    next_index = Instant::now()
                        .checked_add(MIN_WAKE_INTERVAL)
                        .expect("One-second wake deadline fits monotonic clock");
                    let result = async {
                        let outcome = self.cycle(&mut count_cache).await?;
                        let state =
                            self.store.state().await?.ok_or_else(|| {
                                eyre::eyre!("Missing initialized near-head state")
                            })?;
                        Ok::<_, eyre::Report>((outcome, state))
                    }
                    .await;
                    // Re-anchor retained WS ancestry to the actual HTTP-indexed hash,
                    // including after a rewind. Never retain a tip solely by height.
                    tip = None;
                    result.map(|(outcome, state)| {
                        tip = linked_tip(&recent, &state);
                        outcome
                    })
                }
                Wakeup::Head(headers) => {
                    remember_headers(&mut recent, headers);
                    let result = self.header_cycle(headers, &mut tip, &count_cache).await;
                    next_head = Instant::now()
                        .checked_add(MIN_HEAD_INTERVAL)
                        .expect("Header deadline fits monotonic clock");
                    result
                }
            };
            let failed = result
                .as_ref()
                .map_or(true, |outcome| outcome.ingestion_failed);
            let critical = failures.record(failed, self.critical_failure_grace);
            self.chain_metrics
                .set_critical_error(self.domain.name(), critical);
            match result {
                Ok(CycleOutcome { more: true, .. }) => {
                    if let Wakeup::Head(batch) = &mut wakeup {
                        // Ancestry was checked once; drain publication pages at its tip.
                        batch.drain(..batch.len().saturating_sub(1));
                    }
                    continue;
                }
                Ok(CycleOutcome { more: false, .. }) => {}
                Err(error) => warn!(
                    domain = self.store.domain,
                    ?error,
                    "Near-head indexing paused; retrying"
                ),
            }
            let retry_delay = failed
                .then(|| failures.retry_delay(self.poll_interval, self.critical_failure_grace));
            // A WS log may arrive before the HTTP provider exposes its block.
            let catching_up = self.wanted.load(Ordering::Relaxed) != 0;
            wakeup = wait_for_work(
                &self.wakeup,
                &mut heads,
                &mut polling,
                retry_delay,
                next_index,
                next_head,
                catching_up,
            )
            .await;
        }
    }

    async fn cycle(&self, count_cache: &mut CountCache) -> eyre::Result<CycleOutcome> {
        self.store
            .claim(confirmation_lease(self.poll_interval))
            .await?;
        self.source.begin_cycle().await;
        let mut observed = match observe(self.source.as_ref(), &self.store).await {
            Ok(state) => state,
            Err(error) => {
                self.store.pause(false).await?;
                return Err(error);
            }
        };
        // Reuse this observation to detect stalled WebSocket delivery; no probe RPC.
        self.polled_head.send_replace(observed.head);
        // Ingest before publication so newly indexed events do not wait for the
        // next poll. Keep the result so existing work can still publish when
        // the log query fails.
        let depth = match &self.period {
            ReorgPeriod::Blocks(depth) => u64::from(depth.get()),
            _ => 0,
        };
        let tip_counts = self.source.tip_sequence_counts().await?;
        let count_protected = tip_counts.is_some();
        // Sources with hash-pinned historical counts publish only ranges those
        // counts have proven complete.
        let proof_gated = !count_protected && self.source.has_historical_counts();
        // A reorg or rewind invalidates any proof above the surviving frontier.
        count_cache.proven_through = count_cache
            .proven_through
            .map(|proven| proven.min(observed.indexed));
        // Ranges appended while historical counts were unavailable stay
        // provisional until a later hash-pinned count proves them complete;
        // their tail cannot be checked otherwise. Let ingestion run past the
        // provisional cap meanwhile so pruned-state RPCs can reach a boundary
        // whose counts are still available.
        let mut unproven_suffix = proof_gated
            && count_cache.proven_through.unwrap_or(observed.confirmed) < observed.indexed;
        if unproven_suffix {
            // Proofs live in memory only, so re-prove the suffix at the indexed
            // boundary, e.g. after a restart or while log queries fail.
            match self.source.counts(observed.hash).await {
                Ok(Some(counts)) => {
                    let stored = self.store.sequence_counts().await?;
                    if counts == [stored[0], stored[3]] {
                        count_cache.proven_through = Some(observed.indexed);
                    } else {
                        // The suffix is provably incomplete; replay it rather
                        // than waiting for a new block to expose the gap.
                        warn!(
                            domain = self.store.domain,
                            height = observed.indexed,
                            ?counts,
                            "Unproven provisional suffix is incomplete; replaying it"
                        );
                        self.store.rewind_to_confirmed(&observed).await?;
                        count_cache.boundary = None;
                        count_cache.proven_through = Some(observed.confirmed);
                        // A rewind leaves the head unhealthy until it is observed again.
                        observed = observe(self.source.as_ref(), &self.store).await?;
                    }
                    unproven_suffix = false;
                }
                Ok(None) => {}
                Err(error) => debug!(
                    domain = self.store.domain,
                    height = observed.indexed,
                    ?error,
                    "Counts unavailable at the indexed boundary; keeping the suffix provisional"
                ),
            }
        }
        let mut bounded = observed.clone();
        if !count_protected && !unproven_suffix {
            bounded.head = bounded.head.min(
                bounded
                    .confirmed
                    .saturating_add(depth)
                    .saturating_add(10_000),
            );
        }
        let mut ingestion = if bounded.indexed < bounded.head {
            ingest_cached(
                self.source.as_ref(),
                &self.store,
                &bounded,
                self.chunk_size,
                count_cache,
            )
            .await
        } else {
            Ok(false)
        };

        // Count-protected sources publish only history proven by this cycle's
        // snapshot. Any failure leaves their existing confirmed frontier alone.
        let mut publishable = if count_protected {
            observed.confirmed
        } else if proof_gated {
            count_cache
                .proven_through
                .unwrap_or(observed.confirmed)
                .max(observed.confirmed)
        } else {
            u64::MAX
        };
        if let Some(expected) = tip_counts.filter(|_| ingestion.is_ok()) {
            let state = self
                .store
                .state()
                .await?
                .ok_or_else(|| eyre::eyre!("Missing head state"))?;
            let actual = self.store.sequence_counts().await?;
            let mut incomplete = false;
            let mut unavailable = false;
            let mut stale = false;
            let mut proven = state.indexed;
            for (((expected, tip), actual), stream) in expected.into_iter().zip(actual).zip([
                "dispatch",
                "delivery",
                "gas payment",
                "insertion",
            ]) {
                let Some(expected) = expected else { continue };
                let tip = u64::from(tip);
                if expected < actual {
                    stale = true;
                    warn!(
                        stream,
                        expected,
                        actual,
                        tip,
                        "Provider sequence count is behind durable history at its tip"
                    );
                    continue;
                }
                if tip > state.indexed && expected > actual {
                    unavailable = true;
                    continue;
                }
                proven = proven.min(tip.min(state.indexed));
                incomplete |= expected > actual;
            }
            if !unavailable && !stale && !incomplete {
                // Retained checkpoints may be pruned below the confirmed
                // frontier, and nothing below it needs publishing again.
                publishable = if proven <= state.confirmed {
                    state.confirmed
                } else {
                    self.store.checkpoint(proven).await?
                };
            } else if !unavailable && !stale && incomplete {
                if state.indexed > state.confirmed {
                    self.store.rewind_to_confirmed(&state).await?;
                }
                count_cache.boundary = None;
                ingestion = Err(eyre::eyre!("Incomplete event range at provider tip"));
            }
        }
        if let Err(error) = &ingestion {
            warn!(
                domain = self.store.domain,
                phase = "ingestion",
                ?error,
                "Near-head indexing phase failed"
            );
        }

        let confirmation = confirm_leased_through(
            self.source.as_ref(),
            &self.store,
            &self.period,
            confirmation_lease(self.poll_interval),
            publishable,
        )
        .await?;
        self.record_progress(confirmation.counts).await?;
        let state = self
            .store
            .state()
            .await?
            .ok_or_else(|| eyre::eyre!("Missing head state"))?;

        // Keep draining confirmed pages while logs fail; the failure was logged
        // above and stays visible through the critical-error metric.
        if confirmation.page_limited {
            return Ok(CycleOutcome {
                more: true,
                ingestion_failed: ingestion.is_err(),
            });
        }
        let more_ingestion = ingestion?;
        let capped_head = state.confirmed.saturating_add(depth).saturating_add(10_000);
        let unproven =
            proof_gated && count_cache.proven_through.unwrap_or(state.confirmed) < state.indexed;
        if unproven && !more_ingestion {
            // Caught up but still unable to prove the suffix: counts by hash
            // should work near head, so surface it through the critical metric.
            warn!(
                domain = self.store.domain,
                confirmed = state.confirmed,
                indexed = state.indexed,
                "Provisional suffix is unproven at head; waiting for historical counts"
            );
            return Ok(CycleOutcome {
                more: false,
                ingestion_failed: true,
            });
        }
        let at_provisional_cap = !count_protected
            && !unproven
            && capped_head < observed.head
            && state.indexed >= capped_head;
        if at_provisional_cap {
            eyre::bail!(
                "Provisional suffix reached its 10,000-block limit; confirmation is lagging"
            );
        }
        Ok(CycleOutcome {
            more: more_ingestion,
            ingestion_failed: false,
        })
    }
    /// Advance only along streamed ancestry rooted at the indexed hash. No RPCs.
    async fn header_cycle(
        &self,
        headers: &[Header],
        tip: &mut Option<Header>,
        cache: &CountCache,
    ) -> eyre::Result<CycleOutcome> {
        let idle = CycleOutcome {
            more: false,
            ingestion_failed: false,
        };
        let mut state = self
            .store
            .state()
            .await?
            .ok_or_else(|| eyre::eyre!("Missing head state"))?;
        if state.halted {
            return Ok(idle);
        }
        let http_limit = self.polled_head.borrow().saturating_add(MAX_HEADER_LEAD);
        if headers
            .last()
            .is_some_and(|header| header.height > http_limit)
        {
            debug!(
                domain = self.store.domain,
                http_limit, "Streamed head exceeds HTTP lead limit; waiting for polling"
            );
            return Ok(idle);
        }
        let mut latest = tip.clone();
        for header in headers
            .iter()
            .filter(|header| header.height > state.indexed)
        {
            let (height, hash) = latest
                .as_ref()
                .map_or((state.indexed, state.hash), |tip| (tip.height, tip.hash));
            if latest.as_ref() != Some(header)
                && (height.checked_add(1) != Some(header.height) || header.parent != hash)
            {
                // Validate every parent before coalescing; never bridge gaps/forks.
                *tip = None;
                debug!(
                    domain = self.store.domain,
                    height = header.height,
                    "Header ancestry unavailable; waiting for polling"
                );
                return Ok(idle);
            }
            latest = Some(header.clone());
        }
        let Some(header) = latest else {
            return Ok(idle);
        };
        if header.height <= state.indexed {
            return Ok(idle);
        }
        let lease = confirmation_lease(self.poll_interval);
        if tip.as_ref() != Some(&header) || state.head < header.height {
            self.store
                .advance_head(&state, header.height, lease)
                .await?;
        }
        state.head = state.head.max(header.height);
        *tip = Some(header.clone());
        let through = match &self.period {
            ReorgPeriod::Blocks(depth) => header.height.saturating_sub(u64::from(depth.get())),
            ReorgPeriod::Tag(tag) if tag == "latest" => header.height,
            // Latest headers cannot prove safe/finalized tags.
            _ => return Ok(idle),
        }
        .min(state.indexed)
        .min(cache.proven_through.unwrap_or(state.confirmed));
        if through <= state.confirmed {
            return Ok(idle);
        }
        let bounded = self
            .store
            .confirmation_boundary(state.confirmed, through)
            .await?;
        // Ingestion retained every event block and the indexed boundary.
        // Empty gaps need no new header to publish all eligible events.
        let Some(boundary) = self
            .store
            .confirmation_checkpoint(state.confirmed, bounded)
            .await?
        else {
            return Ok(idle);
        };
        let counts = self.store.confirm(&state, &boundary, lease).await?;
        self.record_progress(counts).await?;
        Ok(CycleOutcome {
            more: bounded < through,
            ingestion_failed: false,
        })
    }

    async fn record_progress(&self, counts: [u64; 4]) -> eyre::Result<()> {
        for (label, count) in [
            "raw_message_dispatch",
            "message_delivery",
            "gas_payment",
            "merkle_tree_insertion",
        ]
        .into_iter()
        .zip(counts)
        {
            self.sync_metrics
                .stored_events
                .with_label_values(&[label, self.domain.name()])
                .inc_by(count);
        }

        let state = self
            .store
            .state()
            .await?
            .ok_or_else(|| eyre::eyre!("Missing head state"))?;
        // Clear only hints whose blocks are durably indexed; preserve newer logs.
        let _ = self
            .wanted
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |wanted| {
                (wanted <= state.indexed).then_some(0)
            });
        self.sync_metrics
            .indexed_height
            .with_label_values(&["near_head", self.domain.name()])
            .set(i64::try_from(state.indexed)?);
        for label in [
            "message_dispatch",
            "message_delivery",
            "gas_payment",
            "merkle_tree_insertion",
        ] {
            self.sync_metrics
                .indexed_height
                .with_label_values(&[label, self.domain.name()])
                .set(i64::try_from(state.confirmed)?);
        }

        Ok(())
    }
}

// Only interrupt healthy idle waits: incoming logs must not bypass RPC-error backoff.
async fn wait_for_work(
    wakeup: &Notify,
    heads: &mut mpsc::Receiver<Header>,
    polling: &mut Interval,
    retry_delay: Option<Duration>,
    next_index: Instant,
    next_head: Instant,
    catching_up: bool,
) -> Wakeup {
    if let Some(delay) = retry_delay {
        sleep(delay).await;
        Wakeup::Index
    } else {
        tokio::select! {
            // Header traffic must not starve scheduled or event-triggered indexing.
            biased;
            _ = polling.tick() => Wakeup::Index,
            _ = async {
                sleep_until(next_index).await;
                if catching_up {
                    let _ = wakeup.notified().now_or_never();
                } else {
                    wakeup.notified().await;
                }
            } => Wakeup::Index,
            Some(header) = async {
                sleep_until(next_head).await;
                heads.recv().await
            } => {
                let mut batch = vec![header];
                while let Ok(header) = heads.try_recv() {
                    batch.push(header);
                }
                Wakeup::Head(batch)
            },
        }
    }
}

#[cfg(test)]
mod tests;
