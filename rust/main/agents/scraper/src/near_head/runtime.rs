//! One state writer per chain. RPC work remains asynchronous, but observation,
//! publication and ingestion never contend for the same `scraper_head` row.
use std::{collections::VecDeque, sync::Arc, time::Duration};

use hyperlane_base::{ChainMetrics, ContractSyncMetrics};
use hyperlane_core::{HyperlaneDomain, HyperlaneDomainProtocol, ReorgPeriod};
use tokio::{
    sync::{mpsc, watch, Notify},
    time::{interval, sleep, sleep_until, Instant, MissedTickBehavior},
};
use tracing::{debug, warn};

use super::{
    pipeline::{confirm_leased_through, confirmation_lease, ingest_cached, observe, CountCache},
    source::{Header, Source},
    store::{State, Store},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct PolledEventSlots {
    pub startup_head: u64,
    pub indexed: [u64; 3],
}

/// The latest block to fetch, plus an unconditional wake for reconnects and reorgs.
#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub(super) struct IndexWakeup {
    pub height: u64,
    pub reconcile: bool,
}

impl IndexWakeup {
    pub(super) fn send(self, tx: &watch::Sender<Self>) {
        tx.send_if_modified(|pending| {
            let next = Self {
                height: pending.height.max(self.height),
                reconcile: pending.reconcile || self.reconcile,
            };
            std::mem::replace(pending, next) != next
        });
    }

    fn take(tx: &watch::Sender<Self>) -> Self {
        let mut wake = Self::default();
        tx.send_if_modified(|pending| {
            wake = std::mem::take(pending);
            false // Clearing the pending work does not wake the worker.
        });
        wake
    }
}

pub(super) struct Worker {
    pub source: Box<dyn Source>,
    pub store: Store,
    pub domain: HyperlaneDomain,
    pub period: ReorgPeriod,
    pub chunk_size: u64,
    pub poll_interval: Duration,
    pub wakeup: watch::Sender<IndexWakeup>,
    pub dispatch_wakeup: Arc<Notify>,
    pub receipt_wakeup: watch::Sender<()>,
    pub polled_head: watch::Sender<u64>,
    pub polled_event_slots: watch::Sender<Option<PolledEventSlots>>,
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

/// A completed cycle: whether to run again at once, and whether ingestion failed
/// while existing work still published.
#[derive(Debug)]
pub(super) struct CycleOutcome {
    indexed: u64,
    pub more: bool,
    pub ingestion_failed: bool,
}

const INDEX_RETRY_DELAYS: [Duration; 6] = [
    Duration::from_millis(200),
    Duration::from_millis(200),
    Duration::from_millis(200),
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(4),
];
const RECENT_HEADERS: usize = 256;
// At 250ms/block this allows 16s of HTTP/WS skew without trusting an unbounded lead.
const MAX_HEADER_LEAD: u64 = 64;

fn remember_header(recent: &mut VecDeque<Header>, header: Header) {
    if recent.back() == Some(&header) {
        return;
    }
    if recent.back().is_some_and(|tip| {
        tip.height.checked_add(1) != Some(header.height) || header.parent != tip.hash
    }) {
        recent.clear();
    }
    recent.push_back(header);
    if recent.len() > RECENT_HEADERS {
        recent.pop_front();
    }
}

fn linked_tip<'a>(recent: &'a VecDeque<Header>, state: &State) -> Option<&'a Header> {
    let anchored = recent.iter().any(|header| {
        (header.height == state.indexed && header.hash == state.hash)
            || (state.indexed.checked_add(1) == Some(header.height) && header.parent == state.hash)
    });
    if !anchored {
        return None;
    }
    recent.back().filter(|tip| tip.height > state.indexed)
}

impl Worker {
    pub async fn run(&self, heads: mpsc::Receiver<Header>) {
        let stagger_period = u64::try_from(self.poll_interval.as_millis())
            .unwrap_or(u64::MAX)
            .max(1);
        let stagger = u64::from(self.domain.id())
            .wrapping_mul(0x9E37_79B9_7F4A_7C15)
            .checked_rem(stagger_period)
            .unwrap_or_default();
        sleep(Duration::from_millis(stagger)).await;
        self.run_cycles(heads).await
    }

    async fn run_cycles(&self, mut heads: mpsc::Receiver<Header>) {
        let mut count_cache = CountCache::default();
        let mut failures = FailureStreak::default();
        let mut polling = interval(self.poll_interval);
        polling.reset(); // The first cycle runs immediately.
        polling.set_missed_tick_behavior(MissedTickBehavior::Skip);
        let mut wakeups = self.wakeup.subscribe();
        let mut recent = VecDeque::with_capacity(RECENT_HEADERS);
        let mut index = true;
        let mut confirm = false;
        let mut next_retry = Instant::now();
        let mut retry = 0usize;
        let (mut indexed, mut wanted) = (0, 0);
        loop {
            // Collect both sources before running RPCs, including when a poll won the wake.
            let wake = IndexWakeup::take(&self.wakeup);
            index |= wake.reconcile;
            if wake.height > indexed.max(wanted) {
                wanted = wake.height;
                index = true;
            }
            for _ in 0..heads.max_capacity() {
                let Ok(header) = heads.try_recv() else { break };
                remember_header(&mut recent, header);
                confirm = true;
            }
            let result = async {
                if std::mem::take(&mut index) {
                    let started = Instant::now();
                    let outcome = self.cycle(&mut count_cache).await?;
                    indexed = outcome.indexed;
                    if wanted <= indexed {
                        wanted = 0;
                        retry = 0;
                    } else {
                        let delay = INDEX_RETRY_DELAYS
                            .get(retry)
                            .copied()
                            .unwrap_or(self.poll_interval);
                        next_retry = started
                            .checked_add(delay.min(self.poll_interval))
                            .expect("Index retry deadline");
                    }
                    index = outcome.more;
                    if outcome.ingestion_failed {
                        return Ok(true);
                    }
                    // HTTP already checked confirmations through its observed head.
                    confirm &= recent
                        .back()
                        .is_some_and(|header| header.height > *self.polled_head.borrow());
                }
                if std::mem::take(&mut confirm) {
                    confirm = self.header_cycle(&recent, &count_cache).await?;
                }
                Ok::<_, eyre::Report>(false)
            }
            .await;
            let failed = result.as_ref().copied().unwrap_or(true);
            let critical = failures.record(failed, self.critical_failure_grace);
            self.chain_metrics
                .set_critical_error(self.domain.name(), critical);
            match result {
                Ok(_) if index || (!failed && confirm) => continue,
                Ok(_) => {}
                Err(error) => warn!(
                    domain = self.store.domain,
                    ?error,
                    "Near-head indexing paused; retrying"
                ),
            }
            if failed {
                // Neither subscription may bypass RPC-error backoff.
                sleep(failures.retry_delay(self.poll_interval, self.critical_failure_grace)).await;
                index = true;
                continue;
            }
            tokio::select! {
                biased;
                _ = polling.tick() => index = true,
                // Pace retries when HTTP is still behind the last notification.
                _ = sleep_until(next_retry), if wanted != 0 => {
                    retry = retry.saturating_add(1);
                    index = true;
                },
                _ = wakeups.wait_for(|wake| wake.reconcile || wake.height > indexed.max(wanted)) => {},
                Some(header) = heads.recv() => {
                    remember_header(&mut recent, header);
                    confirm = true;
                }
            }
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
        if self.domain.domain_protocol() == HyperlaneDomainProtocol::Sealevel
            && self.polled_event_slots.borrow().is_none()
        {
            // Historical catch-up below the first live finalized head is expected.
            self.polled_event_slots.send_replace(Some(PolledEventSlots {
                startup_head: observed.head,
                indexed: [0; 3],
            }));
        }
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
            Ok((false, false))
        };
        if ingestion
            .as_ref()
            .is_ok_and(|(_, wrote_events)| *wrote_events)
        {
            self.receipt_wakeup.send_replace(());
            self.polled_event_slots.send_if_modified(|slots| {
                let Some(sample) = slots else { return false };
                let changed = sample.indexed != count_cache.event_slots;
                sample.indexed = count_cache.event_slots;
                changed
            });
        }

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
        let state = self
            .store
            .state()
            .await?
            .ok_or_else(|| eyre::eyre!("Missing head state"))?;

        self.record_progress(&state, confirmation.counts)?;

        // Keep draining confirmed pages while logs fail; the failure was logged
        // above and stays visible through the critical-error metric.
        if confirmation.page_limited {
            return Ok(CycleOutcome {
                indexed: state.indexed,
                more: true,
                ingestion_failed: ingestion.is_err(),
            });
        }
        let (more_ingestion, _) = ingestion?;
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
                indexed: state.indexed,
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
            indexed: state.indexed,
            more: more_ingestion,
            ingestion_failed: false,
        })
    }
    /// Recent headers must descend from the current indexed hash, including after polls/rewinds.
    async fn header_cycle(
        &self,
        recent: &VecDeque<Header>,
        cache: &CountCache,
    ) -> eyre::Result<bool> {
        let mut state = self
            .store
            .state()
            .await?
            .ok_or_else(|| eyre::eyre!("Missing head state"))?;
        let Some(header) = linked_tip(recent, &state) else {
            return Ok(false);
        };
        if state.halted || header.height > self.polled_head.borrow().saturating_add(MAX_HEADER_LEAD)
        {
            return Ok(false);
        }
        let lease = confirmation_lease(self.poll_interval);
        self.store
            .advance_head(&state, header.height, lease)
            .await?;
        state.head = state.head.max(header.height);
        let through = match &self.period {
            ReorgPeriod::Blocks(depth) => header.height.saturating_sub(u64::from(depth.get())),
            ReorgPeriod::Tag(tag) if tag == "latest" => header.height,
            _ => {
                let confirmation = confirm_leased_through(
                    self.source.as_ref(),
                    &self.store,
                    &self.period,
                    lease,
                    cache.proven_through.unwrap_or(state.confirmed),
                )
                .await?;
                state = self
                    .store
                    .state()
                    .await?
                    .ok_or_else(|| eyre::eyre!("Missing head state"))?;
                self.record_progress(&state, confirmation.counts)?;
                return Ok(confirmation.page_limited);
            }
        }
        .min(state.indexed)
        .min(cache.proven_through.unwrap_or(state.confirmed));
        if through <= state.confirmed {
            return Ok(false);
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
            return Ok(false);
        };
        let counts = self.store.confirm(&state, &boundary, lease).await?;
        state.confirmed = boundary.height;
        self.record_progress(&state, counts)?;
        Ok(bounded < through)
    }

    fn record_progress(&self, state: &State, counts: [u64; 4]) -> eyre::Result<()> {
        // Both HTTP and head-driven confirmations have committed before this call.
        if counts[0] > 0 {
            self.dispatch_wakeup.notify_one();
        }
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

#[cfg(test)]
mod tests;
