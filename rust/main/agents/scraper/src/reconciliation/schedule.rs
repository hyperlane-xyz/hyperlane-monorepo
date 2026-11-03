//! Discovery takes priority over full sweeps; failures defer only the affected lane.
use hyperlane_core::rpc_clients::RPC_RETRY_SLEEP_DURATION;
use std::time::Duration;
use tokio::time::Instant;

use super::dispatches::PageResult;

pub(super) const BATCH_SIZE: u64 = 100;
// New confirmed dispatches become eligible for enrichment every 5 seconds.
const DISCOVERY_INTERVAL: Duration = Duration::from_secs(5);
const PAGE_DELAY: Duration = Duration::from_secs(2);

// A full sweep is only a correctness fallback for sequence commit-order races and old rows whose
// body is populated after the incremental watermark passes them. Start sweeps on a fixed cadence
// so a long-running generation does not add another full interval before its successor starts.
const FULL_SWEEP_INTERVAL: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, Clone, Copy)]
pub(super) struct Scan {
    pub(super) after_id: i64,
    pub(super) through_id: i64,
    pub(super) next_page_at: Instant,
}

impl Scan {
    fn new(after_id: i64, through_id: i64, now: Instant) -> Option<Self> {
        (through_id > after_id).then_some(Self {
            after_id,
            through_id,
            next_page_at: now,
        })
    }

    /// Returns true once the snapshot is exhausted. A full page advances only to the last row
    /// returned; a short page proves that every candidate through the immutable frontier was read.
    fn complete_page(&mut self, result: &PageResult, now: Instant) -> bool {
        if result.candidate_count < BATCH_SIZE as usize {
            true
        } else {
            self.after_id = result.next_after_id;
            self.next_page_at = instant_after(now, PAGE_DELAY);
            false
        }
    }
}

pub(super) fn instant_after(now: Instant, duration: Duration) -> Instant {
    now.checked_add(duration).unwrap_or(now)
}

fn failed_lane_retry_at(now: Instant) -> Instant {
    // Keep the failed lane asleep for two global cooldowns. When the first cooldown expires,
    // another due lane gets a turn instead of the same failure monopolizing every wake.
    let delay = RPC_RETRY_SLEEP_DURATION
        .checked_mul(2)
        .unwrap_or(Duration::MAX);
    instant_after(now, delay)
}

#[derive(Debug)]
pub(super) struct Schedule {
    pub(super) discovery_watermark: i64,
    pub(super) discovery_scan: Option<Scan>,
    pub(super) full_sweep: Option<Scan>,
    pub(super) next_discovery_at: Instant,
    pub(super) next_full_sweep_at: Instant,
    pub(super) retry_not_before: Instant,
    pub(super) global_not_before: Instant,
}

impl Schedule {
    pub(super) fn new(discovery_watermark: i64, now: Instant, global_not_before: Instant) -> Self {
        Self {
            discovery_watermark,
            discovery_scan: None,
            full_sweep: None,
            next_discovery_at: now,
            next_full_sweep_at: now,
            retry_not_before: now,
            global_not_before,
        }
    }

    pub(super) fn scan_slot_available(&self) -> bool {
        self.discovery_scan.is_none() && self.full_sweep.is_none()
    }

    pub(super) fn discovery_slot_available(&self) -> bool {
        self.discovery_scan.is_none()
    }

    pub(super) fn discovery_delay(&self, now: Instant) -> Duration {
        match self.discovery_scan {
            Some(scan) => scan.next_page_at.saturating_duration_since(now),
            None => self.next_discovery_at.saturating_duration_since(now),
        }
    }

    pub(super) fn full_sweep_delay(&self, now: Instant) -> Duration {
        match (self.full_sweep, self.discovery_scan) {
            (Some(_), Some(_)) => Duration::MAX,
            (Some(scan), None) => scan.next_page_at.saturating_duration_since(now),
            (None, Some(_)) => Duration::MAX,
            (None, None) => self.next_full_sweep_at.saturating_duration_since(now),
        }
    }

    pub(super) fn start_discovery(&mut self, frontier: i64, now: Instant) {
        debug_assert!(self.discovery_slot_available());
        self.discovery_scan = Scan::new(self.discovery_watermark, frontier, now);
        if self.discovery_scan.is_none() {
            self.next_discovery_at = instant_after(now, DISCOVERY_INTERVAL);
        }
    }

    pub(super) fn start_full_sweep(&mut self, frontier: i64, now: Instant) {
        debug_assert!(self.scan_slot_available());
        self.next_full_sweep_at = instant_after(now, FULL_SWEEP_INTERVAL);
        self.full_sweep = Scan::new(0, frontier, now);
    }

    pub(super) fn complete_discovery_page(
        &mut self,
        mut scan: Scan,
        result: &PageResult,
        now: Instant,
    ) {
        if scan.complete_page(result, now) {
            self.discovery_watermark = self.discovery_watermark.max(scan.through_id);
            self.discovery_scan = None;
            self.next_discovery_at = instant_after(now, DISCOVERY_INTERVAL);
        } else {
            self.discovery_scan = Some(scan);
        }
    }

    pub(super) fn complete_full_sweep_page(
        &mut self,
        mut scan: Scan,
        result: &PageResult,
        now: Instant,
    ) {
        let complete = scan.complete_page(result, now);
        let covered_through = if complete {
            scan.through_id
        } else {
            scan.after_id
        };
        self.discovery_watermark = self.discovery_watermark.max(covered_through);
        if complete {
            self.full_sweep = None;
        } else {
            self.full_sweep = Some(scan);
        }
    }

    pub(super) fn defer_retry_lane(&mut self, now: Instant) {
        self.global_not_before = instant_after(now, RPC_RETRY_SLEEP_DURATION);
        self.retry_not_before = failed_lane_retry_at(now);
    }

    pub(super) fn defer_discovery_frontier(&mut self, now: Instant) {
        self.global_not_before = instant_after(now, RPC_RETRY_SLEEP_DURATION);
        self.next_discovery_at = failed_lane_retry_at(now);
    }

    pub(super) fn defer_discovery_page(&mut self, scan: Scan, now: Instant) {
        self.global_not_before = instant_after(now, RPC_RETRY_SLEEP_DURATION);
        self.discovery_scan = Some(Scan {
            next_page_at: failed_lane_retry_at(now),
            ..scan
        });
    }

    pub(super) fn defer_sweep_frontier(&mut self, now: Instant) {
        self.global_not_before = instant_after(now, RPC_RETRY_SLEEP_DURATION);
        self.next_full_sweep_at = failed_lane_retry_at(now);
    }

    pub(super) fn defer_sweep_page(&mut self, scan: Scan, now: Instant) {
        self.global_not_before = instant_after(now, RPC_RETRY_SLEEP_DURATION);
        self.full_sweep = Some(Scan {
            next_page_at: failed_lane_retry_at(now),
            ..scan
        });
    }
}

#[cfg(test)]
mod tests;
