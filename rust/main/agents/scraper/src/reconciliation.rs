//! Enrich confirmed dispatches through discovery, bounded retries, and periodic full sweeps.
mod dispatches;
mod metrics;
mod schedule;

use futures::FutureExt;
use hyperlane_base::ContractSyncMetrics;
use hyperlane_core::{rpc_clients::RPC_RETRY_SLEEP_DURATION, HyperlaneDomain};
use prometheus::IntGaugeVec;
use std::{panic::AssertUnwindSafe, sync::Arc, time::Duration};
use tokio::{task::JoinHandle, time::Instant};
use tracing::{info, info_span, warn, Instrument};

use crate::store::HyperlaneDbStore;
use dispatches::RetryBackoff;
pub(crate) use metrics::ReconciliationMetrics;
use metrics::{sleep_with_liveness, update_liveness_metric};
use schedule::{instant_after, Schedule, BATCH_SIZE};

const RETRY_BATCH_SIZE: usize = 100;
const DISCOVERY_FRONTIER: &str = "discovery_frontier";
const DISCOVERY_PAGE: &str = "discovery_page";
const RETRY_PAGE: &str = "retry_page";
const SWEEP_FRONTIER: &str = "sweep_frontier";
const SWEEP_PAGE: &str = "sweep_page";

pub(crate) fn spawn(
    domain: HyperlaneDomain,
    contract_sync_metrics: Arc<ContractSyncMetrics>,
    raw_dispatch_unenriched_max_age: IntGaugeVec,
    reconciliation_metrics: ReconciliationMetrics,
    store: HyperlaneDbStore,
) -> JoinHandle<()> {
    let domain_name = domain.name().to_owned();
    let span_domain_name = domain_name.clone();
    tokio::spawn(
        async move {
            let stored_events_metric = contract_sync_metrics
                .stored_events
                .with_label_values(&["message_dispatch_reconciled", &domain_name]);
            let liveness_metric = contract_sync_metrics.liveness_metrics.with_label_values(&[
                "raw_message_dispatch_reconciliation",
                &domain_name,
                "reconcile_task",
            ]);
            let max_age_metric = raw_dispatch_unenriched_max_age.with_label_values(&[&domain_name]);
            let mut retry_backoff = RetryBackoff::default();

            update_liveness_metric(&liveness_metric);
            let initial_frontier = AssertUnwindSafe(store.latest_reconcilable_raw_dispatch_id())
                .catch_unwind()
                .await;
            let (discovery_watermark, global_not_before) = match initial_frontier {
                Ok(Ok(frontier)) => (frontier, Instant::now()),
                Ok(Err(err)) => {
                    warn!(
                        ?err,
                        domain = domain_name,
                        "Failed to initialize raw dispatch discovery watermark"
                    );
                    let now = Instant::now();
                    (0, instant_after(now, RPC_RETRY_SLEEP_DURATION))
                }
                Err(_) => {
                    warn!(
                        domain = domain_name,
                        "Raw dispatch discovery watermark initialization panicked; retrying"
                    );
                    let now = Instant::now();
                    (0, instant_after(now, RPC_RETRY_SLEEP_DURATION))
                }
            };
            let now = Instant::now();
            let mut schedule = Schedule::new(discovery_watermark, now, global_not_before);

            loop {
                update_liveness_metric(&liveness_metric);
                let now = Instant::now();
                if schedule.global_not_before > now {
                    sleep_with_liveness(
                        schedule.global_not_before.saturating_duration_since(now),
                        &liveness_metric,
                    )
                    .await;
                    continue;
                }
                let mut cycle_failed = false;

                let due_raw_ids =
                    retry_backoff.due_raw_ids(time::OffsetDateTime::now_utc(), RETRY_BATCH_SIZE);
                if schedule.retry_not_before <= now && !due_raw_ids.is_empty() {
                    let result = reconciliation_metrics
                        .run(
                            &domain_name,
                            RETRY_PAGE,
                            store.retry_dispatches(&due_raw_ids, &mut retry_backoff),
                        )
                        .await;
                    match result {
                        Some(result) => {
                            stored_events_metric.inc_by(result.stored_count.into());
                            info!(
                                kind = RETRY_PAGE,
                                requested = due_raw_ids.len(),
                                candidates = result.candidate_count,
                                attempted = result.attempted_count,
                                stored = result.stored_count,
                                domain = domain_name,
                                "Reconciled raw message dispatches"
                            );
                        }
                        None => {
                            schedule.defer_retry_lane(Instant::now());
                            cycle_failed = true;
                        }
                    }
                }

                let now = Instant::now();
                if !cycle_failed
                    && schedule.discovery_slot_available()
                    && schedule.next_discovery_at <= now
                {
                    let frontier = reconciliation_metrics
                        .run(
                            &domain_name,
                            DISCOVERY_FRONTIER,
                            store.latest_reconcilable_raw_dispatch_id(),
                        )
                        .await;
                    match frontier {
                        Some(frontier) => schedule.start_discovery(frontier, now),
                        None => {
                            schedule.defer_discovery_frontier(Instant::now());
                            cycle_failed = true;
                        }
                    }
                }

                if let Some(scan) = schedule
                    .discovery_scan
                    .filter(|scan| !cycle_failed && scan.next_page_at <= now)
                {
                    let result = reconciliation_metrics
                        .run(
                            &domain_name,
                            DISCOVERY_PAGE,
                            store.reconcile_page(
                                scan.after_id,
                                scan.through_id,
                                BATCH_SIZE,
                                &mut retry_backoff,
                            ),
                        )
                        .await;
                    match result {
                        Some(result) => {
                            stored_events_metric.inc_by(result.stored_count.into());
                            reconciliation_metrics.record_page(
                                &domain_name,
                                DISCOVERY_PAGE,
                                scan,
                                &result,
                            );
                            schedule.complete_discovery_page(scan, &result, Instant::now());
                        }
                        None => {
                            schedule.defer_discovery_page(scan, Instant::now());
                            cycle_failed = true;
                        }
                    }
                }

                let now = Instant::now();
                if !cycle_failed
                    && schedule.scan_slot_available()
                    && schedule.next_full_sweep_at <= now
                {
                    let frontier = reconciliation_metrics
                        .run(
                            &domain_name,
                            SWEEP_FRONTIER,
                            store.latest_reconcilable_raw_dispatch_id(),
                        )
                        .await;
                    match frontier {
                        Some(frontier) => schedule.start_full_sweep(frontier, now),
                        None => {
                            schedule.defer_sweep_frontier(Instant::now());
                            cycle_failed = true;
                        }
                    }
                }

                if let Some(scan) = schedule.full_sweep.filter(|scan| {
                    !cycle_failed && schedule.discovery_scan.is_none() && scan.next_page_at <= now
                }) {
                    let result = reconciliation_metrics
                        .run(
                            &domain_name,
                            SWEEP_PAGE,
                            store.reconcile_page(
                                scan.after_id,
                                scan.through_id,
                                BATCH_SIZE,
                                &mut retry_backoff,
                            ),
                        )
                        .await;
                    match result {
                        Some(result) => {
                            stored_events_metric.inc_by(result.stored_count.into());
                            reconciliation_metrics.record_page(
                                &domain_name,
                                SWEEP_PAGE,
                                scan,
                                &result,
                            );
                            schedule.complete_full_sweep_page(scan, &result, Instant::now());
                        }
                        None => {
                            schedule.defer_sweep_page(scan, Instant::now());
                        }
                    }
                }

                reconciliation_metrics.set_pending_retries(&domain_name, retry_backoff.len());
                max_age_metric.set(
                    retry_backoff
                        .max_unenriched_age_seconds(time::OffsetDateTime::now_utc())
                        .try_into()
                        .unwrap_or(i64::MAX),
                );

                let now = Instant::now();
                let retry_delay = retry_backoff
                    .next_retry_delay(time::OffsetDateTime::now_utc())
                    .unwrap_or(Duration::MAX);
                let retry_delay = if schedule.retry_not_before > now {
                    retry_delay.max(schedule.retry_not_before.saturating_duration_since(now))
                } else {
                    retry_delay
                };
                let discovery_delay = schedule.discovery_delay(now);
                let sweep_delay = schedule.full_sweep_delay(now);
                sleep_with_liveness(
                    retry_delay
                        .min(discovery_delay)
                        .min(sweep_delay)
                        .min(Duration::from_secs(30)),
                    &liveness_metric,
                )
                .await;
            }
        }
        .instrument(info_span!("RawDispatchReconciliation", chain=%span_domain_name)),
    )
}
