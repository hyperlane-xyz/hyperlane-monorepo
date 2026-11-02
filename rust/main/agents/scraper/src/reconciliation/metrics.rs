//! Reconciliation metrics, panic isolation, and liveness during idle waits.
use futures::FutureExt;
use hyperlane_base::CoreMetrics;
use prometheus::{HistogramVec, IntCounterVec, IntGauge, IntGaugeVec};
use std::{
    future::Future,
    panic::AssertUnwindSafe,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::time::{interval, sleep, MissedTickBehavior};
use tracing::{info, warn};

use super::{dispatches::PageResult, schedule::Scan};

const LIVENESS_UPDATE_INTERVAL: Duration = Duration::from_secs(30);

#[derive(Debug, Clone)]
pub(crate) struct ReconciliationMetrics {
    operations: IntCounterVec,
    duration: HistogramVec,
    pending_retries: IntGaugeVec,
    retry_capacity_overflows: IntCounterVec,
}

impl ReconciliationMetrics {
    pub(crate) fn new(metrics: &CoreMetrics) -> Self {
        let operations = metrics
            .new_int_counter(
                "raw_message_dispatch_reconciliation_operations",
                "Number of raw dispatch reconciliation operations",
                &["chain", "kind"],
            )
            .expect("failed to register raw dispatch reconciliation operation metric");
        let duration = metrics
            .new_histogram(
                "raw_message_dispatch_reconciliation_duration_seconds",
                "Raw dispatch reconciliation operation duration",
                &["chain", "kind"],
                vec![0.01, 0.1, 0.5, 1.0, 5.0, 15.0, 30.0, 60.0, 120.0],
            )
            .expect("failed to register raw dispatch reconciliation duration metric");
        let pending_retries = metrics
            .new_int_gauge(
                "raw_message_dispatch_reconciliation_pending_retries",
                "Raw dispatch rows waiting for a direct retry",
                &["chain"],
            )
            .expect("failed to register raw dispatch reconciliation retry metric");
        let retry_capacity_overflows = metrics
            .new_int_counter(
                "raw_message_dispatch_reconciliation_retry_capacity_overflows",
                "Number of missing raw dispatches left to the completeness sweep because the direct retry set was full",
                &["chain"],
            )
            .expect("failed to register raw dispatch reconciliation retry overflow metric");
        Self {
            operations,
            duration,
            pending_retries,
            retry_capacity_overflows,
        }
    }

    pub(super) async fn run<T>(
        &self,
        chain: &str,
        kind: &str,
        operation: impl Future<Output = eyre::Result<T>>,
    ) -> Option<T> {
        self.operations.with_label_values(&[chain, kind]).inc();
        let timer = self
            .duration
            .with_label_values(&[chain, kind])
            .start_timer();
        let result = AssertUnwindSafe(operation).catch_unwind().await;
        timer.observe_duration();
        match result {
            Ok(Ok(value)) => Some(value),
            Ok(Err(error)) => {
                warn!(
                    err = ?error,
                    domain = chain, kind, "Raw dispatch reconciliation failed; retrying"
                );
                None
            }
            Err(_) => {
                warn!(
                    domain = chain,
                    kind, "Raw dispatch reconciliation panicked; retrying"
                );
                None
            }
        }
    }

    pub(super) fn set_pending_retries(&self, chain: &str, count: usize) {
        self.pending_retries
            .with_label_values(&[chain])
            .set(count.try_into().unwrap_or(i64::MAX));
    }

    pub(super) fn record_page(&self, chain: &str, kind: &str, scan: Scan, result: &PageResult) {
        info!(
            kind,
            candidates = result.candidate_count,
            attempted = result.attempted_count,
            skipped_backoff = result.skipped_backoff_count,
            stored = result.stored_count,
            retry_capacity_overflows = result.untracked_count,
            after_id = scan.after_id,
            through_id = scan.through_id,
            domain = chain,
            "Reconciled raw message dispatches"
        );
        self.retry_capacity_overflows
            .with_label_values(&[chain])
            .inc_by(result.untracked_count as u64);
    }
}

pub(super) fn update_liveness_metric(liveness_metric: &IntGauge) {
    let seconds_since_epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    liveness_metric.set(seconds_since_epoch.try_into().unwrap_or(i64::MAX));
}

pub(super) async fn sleep_with_liveness(duration: Duration, liveness_metric: &IntGauge) {
    if duration <= LIVENESS_UPDATE_INTERVAL {
        sleep(duration).await;
        return;
    }

    let sleep = sleep(duration);
    tokio::pin!(sleep);

    let mut liveness_interval = interval(LIVENESS_UPDATE_INTERVAL);
    liveness_interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    liveness_interval.tick().await;

    loop {
        tokio::select! {
            _ = &mut sleep => break,
            _ = liveness_interval.tick() => update_liveness_metric(liveness_metric),
        }
    }
}

#[cfg(test)]
mod tests;
