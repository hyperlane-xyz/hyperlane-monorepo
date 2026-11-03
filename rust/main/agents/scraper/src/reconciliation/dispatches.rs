//! Enrich dispatch pages and retain a bounded retry set for missing transactions.
use std::{
    collections::{HashMap, HashSet},
    time::Duration,
};

use eyre::Result;
use hyperlane_core::H512;
use time::OffsetDateTime;
use tracing::warn;

use crate::store::{txn_id_for_meta, HyperlaneDbStore};

const INITIAL_BACKOFF_SECONDS: i64 = 60;
const MAX_BACKOFF_SECONDS: i64 = 15 * 60;
// At roughly 100 bytes per HashMap entry, 1,000 tracked retries per chain bounds the 76-chain
// fleet near 8 MiB while still retaining more than fifteen current production poison rows per
// affected chain. Overflow remains correct through the periodic completeness sweep.
const TRACKED_RETRY_LIMIT: usize = 1_000;

#[derive(Debug, Default)]
pub(super) struct PageResult {
    pub candidate_count: usize,
    pub attempted_count: usize,
    pub skipped_backoff_count: usize,
    pub untracked_count: usize,
    pub stored_count: u32,
    pub next_after_id: i64,
}

#[derive(Debug, Default)]
pub(super) struct RetryBackoff {
    rows: HashMap<i64, Retry>,
}

#[derive(Debug)]
struct Retry {
    attempts: u32,
    next_retry_at: OffsetDateTime,
    time_created: sea_orm::prelude::TimeDateTime,
}

impl RetryBackoff {
    fn should_attempt(&self, raw_id: i64, now: OffsetDateTime) -> bool {
        match self.rows.get(&raw_id) {
            Some(retry) => retry.next_retry_at <= now,
            None => true,
        }
    }

    fn record_missing(
        &mut self,
        raw_id: i64,
        time_created: sea_orm::prelude::TimeDateTime,
        now: OffsetDateTime,
    ) -> Option<u32> {
        if !self.rows.contains_key(&raw_id) && self.rows.len() >= TRACKED_RETRY_LIMIT {
            return None;
        }
        let retry = self.rows.entry(raw_id).or_insert(Retry {
            attempts: 0,
            next_retry_at: now,
            time_created,
        });
        retry.time_created = time_created;
        retry.attempts = retry.attempts.saturating_add(1);

        let multiplier = 2_i64.pow(retry.attempts.saturating_sub(1).min(4));
        let backoff_seconds = INITIAL_BACKOFF_SECONDS
            .saturating_mul(multiplier)
            .min(MAX_BACKOFF_SECONDS);
        retry.next_retry_at = offset_by_seconds(now, backoff_seconds);
        Some(retry.attempts)
    }

    fn record_success(&mut self, raw_id: i64) {
        self.rows.remove(&raw_id);
    }

    pub(super) fn due_raw_ids(&self, now: OffsetDateTime, limit: usize) -> Vec<i64> {
        let mut due = self
            .rows
            .iter()
            .filter(|(_, retry)| retry.next_retry_at <= now)
            .map(|(raw_id, retry)| (*raw_id, retry.next_retry_at))
            .collect::<Vec<_>>();
        due.sort_unstable_by_key(|(raw_id, next_retry_at)| (*next_retry_at, *raw_id));
        due.into_iter()
            .take(limit)
            .map(|(raw_id, _)| raw_id)
            .collect()
    }

    fn remove_absent(&mut self, requested_raw_ids: &[i64], returned_raw_ids: &HashSet<i64>) {
        for raw_id in requested_raw_ids {
            if !returned_raw_ids.contains(raw_id) {
                self.rows.remove(raw_id);
            }
        }
    }

    pub(super) fn len(&self) -> usize {
        self.rows.len()
    }

    pub(super) fn max_unenriched_age_seconds(&self, now: OffsetDateTime) -> u64 {
        self.rows
            .values()
            .map(|retry| raw_dispatch_age_seconds(retry.time_created, now))
            .max()
            .unwrap_or_default()
    }

    pub(super) fn next_retry_delay(&self, now: OffsetDateTime) -> Option<Duration> {
        self.rows
            .values()
            .map(|retry| {
                if retry.next_retry_at <= now {
                    Duration::ZERO
                } else {
                    retry
                        .next_retry_at
                        .unix_timestamp_nanos()
                        .checked_sub(now.unix_timestamp_nanos())
                        .and_then(|nanos| u64::try_from(nanos).ok())
                        .map(Duration::from_nanos)
                        .unwrap_or(Duration::MAX)
                }
            })
            .min()
    }
}

impl HyperlaneDbStore {
    pub(super) async fn latest_reconcilable_raw_dispatch_id(&self) -> Result<i64> {
        self.db
            .latest_reconcilable_raw_dispatch_id(self.domain.id(), &self.mailbox_address)
            .await
    }

    pub(super) async fn reconcile_page(
        &self,
        after_id: i64,
        through_id: i64,
        limit: u64,
        retry_backoff: &mut RetryBackoff,
    ) -> Result<PageResult> {
        let raw_dispatches = self
            .db
            .retrieve_unenriched_raw_dispatches(
                self.domain.id(),
                &self.mailbox_address,
                after_id,
                through_id,
                limit,
            )
            .await?;
        self.reconcile_candidates(raw_dispatches, retry_backoff)
            .await
    }

    pub(super) async fn retry_dispatches(
        &self,
        raw_ids: &[i64],
        retry_backoff: &mut RetryBackoff,
    ) -> Result<PageResult> {
        let raw_dispatches = self
            .db
            .retrieve_unenriched_raw_dispatches_by_ids(
                self.domain.id(),
                &self.mailbox_address,
                raw_ids,
            )
            .await?;
        let returned_raw_ids = raw_dispatches
            .iter()
            .map(|raw_dispatch| raw_dispatch.raw_id)
            .collect::<HashSet<_>>();
        let result = self
            .reconcile_candidates(raw_dispatches, retry_backoff)
            .await?;
        retry_backoff.remove_absent(raw_ids, &returned_raw_ids);
        Ok(result)
    }

    async fn reconcile_candidates(
        &self,
        raw_dispatches: Vec<crate::db::RawDispatchForEnrichment>,
        retry_backoff: &mut RetryBackoff,
    ) -> Result<PageResult> {
        let now = OffsetDateTime::now_utc();
        if raw_dispatches.is_empty() {
            return Ok(PageResult::default());
        }
        let next_after_id = raw_dispatches
            .iter()
            .map(|raw_dispatch| raw_dispatch.raw_id)
            .max()
            .ok_or_else(|| eyre::eyre!("non-empty reconciliation page has no maximum raw id"))?;
        let skipped_backoff_count = raw_dispatches
            .iter()
            .filter(|raw_dispatch| !retry_backoff.should_attempt(raw_dispatch.raw_id, now))
            .count();
        let raw_dispatches_to_attempt = raw_dispatches
            .iter()
            .filter(|raw_dispatch| retry_backoff.should_attempt(raw_dispatch.raw_id, now))
            .collect::<Vec<_>>();

        if raw_dispatches_to_attempt.is_empty() {
            return Ok(PageResult {
                candidate_count: raw_dispatches.len(),
                skipped_backoff_count,
                next_after_id,
                ..Default::default()
            });
        }

        let txns: HashMap<H512, i64> = self
            .ensure_blocks_and_txns(raw_dispatches_to_attempt.iter().map(|r| &r.meta))
            .await?
            .collect();
        // Start retry delays after the enrichment attempt finishes. A slow RPC batch must
        // not consume the backoff before its missing rows are recorded.
        let attempt_completed_at = OffsetDateTime::now_utc();

        let mut missing_tx_hashes = Vec::new();
        let mut unique_missing_tx_hashes = HashSet::new();
        let mut stored_raw_ids = Vec::new();
        let mut missing_raw_dispatches = Vec::new();
        let storable = raw_dispatches_to_attempt
            .iter()
            .filter_map(
                |raw_dispatch| match txn_id_for_meta(&txns, &raw_dispatch.meta) {
                    Some(txn_id) => {
                        stored_raw_ids.push(raw_dispatch.raw_id);
                        Some(raw_dispatch.storable_message(txn_id))
                    }
                    None => {
                        missing_raw_dispatches
                            .push((raw_dispatch.raw_id, raw_dispatch.time_created));
                        if unique_missing_tx_hashes.insert(raw_dispatch.meta.transaction_id) {
                            missing_tx_hashes.push(raw_dispatch.meta.transaction_id);
                        }
                        None
                    }
                },
            )
            .collect::<Vec<_>>();

        let stored = self
            .db
            .store_dispatched_messages(
                self.domain.id(),
                &self.mailbox_address,
                storable.into_iter(),
            )
            .await?;
        for raw_id in stored_raw_ids {
            retry_backoff.record_success(raw_id);
        }
        let mut untracked_count: usize = 0;
        for (raw_id, time_created) in missing_raw_dispatches {
            match retry_backoff.record_missing(raw_id, time_created, attempt_completed_at) {
                Some(attempts) => warn!(
                    raw_id,
                    attempts,
                    "Raw message dispatch transaction remains unavailable; backing off reconciliation"
                ),
                None => {
                    untracked_count = untracked_count.saturating_add(1);
                }
            }
        }

        if !missing_tx_hashes.is_empty() {
            warn!(
                candidate_count = raw_dispatches.len(),
                attempted = raw_dispatches_to_attempt.len(),
                skipped_backoff = skipped_backoff_count,
                stored,
                missing_tx_hashes = ?missing_tx_hashes,
                "Raw message dispatch reconciliation skipped rows whose transactions are not enriched yet"
            );
        }

        Ok(PageResult {
            candidate_count: raw_dispatches.len(),
            attempted_count: raw_dispatches_to_attempt.len(),
            skipped_backoff_count,
            untracked_count,
            stored_count: stored as u32,
            next_after_id,
        })
    }
}

fn raw_dispatch_age_seconds(
    time_created: sea_orm::prelude::TimeDateTime,
    now: OffsetDateTime,
) -> u64 {
    now.unix_timestamp()
        .saturating_sub(time_created.assume_utc().unix_timestamp())
        .max(0) as u64
}

fn offset_by_seconds(now: OffsetDateTime, seconds: i64) -> OffsetDateTime {
    now.checked_add(time::Duration::seconds(seconds))
        .unwrap_or(now)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_dispatch_retry_backoff_delays_repeated_attempts() {
        let now = OffsetDateTime::now_utc();
        let raw_id = 7;
        let mut backoff = RetryBackoff::default();
        let time_created = crate::date_time::now();

        assert!(backoff.should_attempt(raw_id, now));
        assert_eq!(backoff.record_missing(raw_id, time_created, now), Some(1));
        assert!(!backoff.should_attempt(raw_id, now));
        assert!(!backoff.should_attempt(
            raw_id,
            offset_by_seconds(now, INITIAL_BACKOFF_SECONDS.saturating_sub(1))
        ));
        assert!(backoff.should_attempt(raw_id, offset_by_seconds(now, INITIAL_BACKOFF_SECONDS)));
    }

    #[test]
    fn slow_reconciliation_starts_backoff_after_attempt_completion() {
        let attempt_started_at = OffsetDateTime::now_utc();
        let attempt_completed_at =
            offset_by_seconds(attempt_started_at, INITIAL_BACKOFF_SECONDS + 10);
        let raw_id = 7;
        let mut backoff = RetryBackoff::default();
        let time_created = crate::date_time::now();

        backoff.record_missing(raw_id, time_created, attempt_completed_at);

        assert_eq!(
            backoff.next_retry_delay(attempt_completed_at),
            Some(Duration::from_secs(INITIAL_BACKOFF_SECONDS as u64))
        );
        assert!(!backoff.should_attempt(
            raw_id,
            offset_by_seconds(attempt_completed_at, INITIAL_BACKOFF_SECONDS - 1)
        ));
    }

    #[test]
    fn raw_dispatch_retry_backoff_clears_after_success() {
        let now = OffsetDateTime::now_utc();
        let raw_id = 7;
        let mut backoff = RetryBackoff::default();
        let time_created = crate::date_time::now();

        backoff.record_missing(raw_id, time_created, now);
        assert!(!backoff.should_attempt(raw_id, now));

        backoff.record_success(raw_id);
        assert!(backoff.should_attempt(raw_id, now));
    }

    #[test]
    fn raw_dispatch_retry_backoff_reports_earliest_retry() {
        let now = OffsetDateTime::now_utc();
        let mut backoff = RetryBackoff::default();
        let time_created = crate::date_time::now();

        backoff.record_missing(7, time_created, now);
        backoff.record_missing(8, time_created, offset_by_seconds(now, 30));

        assert_eq!(
            backoff.next_retry_delay(now),
            Some(Duration::from_secs(INITIAL_BACKOFF_SECONDS as u64))
        );
    }

    #[test]
    fn due_raw_ids_are_bounded_and_ordered_by_deadline_then_id() {
        let now = OffsetDateTime::now_utc();
        let mut backoff = RetryBackoff::default();
        let time_created = crate::date_time::now();

        backoff.record_missing(8, time_created, offset_by_seconds(now, -120));
        backoff.record_missing(7, time_created, offset_by_seconds(now, -120));
        backoff.record_missing(9, time_created, offset_by_seconds(now, -60));

        assert_eq!(backoff.due_raw_ids(now, 2), vec![7, 8]);
    }

    #[test]
    fn direct_retry_drops_requested_rows_absent_from_database() {
        let now = OffsetDateTime::now_utc();
        let mut backoff = RetryBackoff::default();
        let time_created = crate::date_time::now();

        backoff.record_missing(7, time_created, now);
        backoff.record_missing(8, time_created, now);
        backoff.remove_absent(&[7, 8], &HashSet::from([8]));

        assert_eq!(backoff.len(), 1);
        assert_eq!(backoff.due_raw_ids(offset_by_seconds(now, 60), 10), vec![8]);
    }

    #[test]
    fn raw_dispatch_retry_backoff_bounds_tracked_rows() {
        let now = OffsetDateTime::now_utc();
        let time_created = crate::date_time::now();
        let mut backoff = RetryBackoff::default();

        for raw_id in 0..TRACKED_RETRY_LIMIT as i64 {
            assert_eq!(backoff.record_missing(raw_id, time_created, now), Some(1));
        }
        assert_eq!(backoff.len(), TRACKED_RETRY_LIMIT);
        assert_eq!(
            backoff.record_missing(TRACKED_RETRY_LIMIT as i64, time_created, now),
            None
        );
        assert_eq!(backoff.len(), TRACKED_RETRY_LIMIT);
        assert_eq!(backoff.record_missing(0, time_created, now), Some(2));
    }
}
