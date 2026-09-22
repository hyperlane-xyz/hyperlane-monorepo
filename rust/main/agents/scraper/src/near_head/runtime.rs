//! Independent ingestion, publication and header-maintenance loops.
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use eyre::ensure;
use hyperlane_base::{ChainMetrics, ContractSyncMetrics};
use hyperlane_core::{HyperlaneDomain, ReorgPeriod};
use tokio::{sync::Notify, time::sleep};
use tracing::warn;

use super::{confirm, ingest_cached, observe, source::Source, store::Store};

pub(super) struct Worker {
    pub source: Box<dyn Source>,
    pub store: Store,
    pub domain: HyperlaneDomain,
    pub period: ReorgPeriod,
    pub chunk_size: u64,
    pub poll_interval: Duration,
    pub chain_metrics: ChainMetrics,
    pub sync_metrics: Arc<ContractSyncMetrics>,
}

impl Worker {
    pub async fn run(&self) {
        let Self {
            source,
            store,
            domain,
            period,
            chunk_size,
            poll_interval,
            chain_metrics,
            sync_metrics,
        } = self;
        let confirmation_wake = Notify::new();
        let ingestion_failed = AtomicBool::new(false);
        let confirmation_failed = AtomicBool::new(false);
        tokio::join!(
            async {
                let mut count_cache = None;
                loop {
                    let result = async {
                        let state = match observe(source.as_ref(), store).await {
                            Ok(state) => state,
                            Err(error) => {
                                store.pause(false).await?;
                                return Err(error);
                            }
                        };
                        confirmation_wake.notify_one();
                        sync_metrics
                            .indexed_height
                            .with_label_values(&["near_head", domain.name()])
                            .set(i64::try_from(state.indexed)?);
                        if confirmation_failed.load(Ordering::Relaxed) {
                            return Ok(false);
                        }
                        // Bound provisional storage even if a valid finality tag stops advancing.
                        let depth = match period {
                            ReorgPeriod::Blocks(depth) => u64::from(depth.get()),
                            _ => 0,
                        };
                        let observed_head = state.head;
                        let mut bounded = state;
                        bounded.head = bounded.head.min(
                            bounded
                                .confirmed
                                .saturating_add(depth)
                                .saturating_add(10_000),
                        );
                        ensure!(
                            bounded.indexed < bounded.head || bounded.head == observed_head,
                            "Confirmation backlog reached its provisional block limit"
                        );
                        if bounded.indexed >= bounded.head {
                            return Ok(false);
                        }
                        let more = ingest_cached(
                            source.as_ref(),
                            store,
                            &bounded,
                            *chunk_size,
                            &mut count_cache,
                        )
                        .await?;
                        confirmation_wake.notify_one();
                        Ok::<_, eyre::Report>(more)
                    }
                    .await;
                    ingestion_failed.store(result.is_err(), Ordering::Relaxed);
                    chain_metrics.set_critical_error(
                        domain.name(),
                        result.is_err() || confirmation_failed.load(Ordering::Relaxed),
                    );
                    match result {
                        Ok(true) => continue,
                        Ok(false) => {}
                        Err(error) => warn!(
                            domain = store.domain,
                            ?error,
                            "Near-head ingestion paused; retrying"
                        ),
                    }
                    sleep(*poll_interval).await;
                }
            },
            async {
                let mut last_confirmed = 0;
                loop {
                    let result = async {
                        let counts = confirm(source.as_ref(), store, period).await?;
                        if let Some(state) = store.state().await? {
                            // Drain confirmation backlogs without waiting another poll interval.
                            if state.confirmed > last_confirmed && state.confirmed < state.indexed {
                                confirmation_wake.notify_one();
                            }
                            last_confirmed = state.confirmed;
                            sync_metrics
                                .indexed_height
                                .with_label_values(&["near_head", domain.name()])
                                .set(i64::try_from(state.indexed)?);
                            for (label, count) in [
                                "raw_message_dispatch",
                                "message_delivery",
                                "gas_payment",
                                "merkle_tree_insertion",
                            ]
                            .into_iter()
                            .zip(counts)
                            {
                                sync_metrics
                                    .stored_events
                                    .with_label_values(&[label, domain.name()])
                                    .inc_by(count);
                            }
                            for label in [
                                "message_dispatch",
                                "message_delivery",
                                "gas_payment",
                                "merkle_tree_insertion",
                            ] {
                                sync_metrics
                                    .indexed_height
                                    .with_label_values(&[label, domain.name()])
                                    .set(i64::try_from(state.confirmed)?);
                            }
                        }
                        Ok::<_, eyre::Report>(())
                    }
                    .await;
                    confirmation_failed.store(result.is_err(), Ordering::Relaxed);
                    chain_metrics.set_critical_error(
                        domain.name(),
                        result.is_err() || ingestion_failed.load(Ordering::Relaxed),
                    );
                    if let Err(error) = result {
                        warn!(
                            domain = store.domain,
                            ?error,
                            "Near-head confirmation paused; retrying"
                        );
                    }
                    tokio::select! {
                        _ = confirmation_wake.notified() => {},
                        _ = sleep(*poll_interval) => {},
                    }
                }
            },
            async {
                let mut prune_after = 0;
                loop {
                    // Maintenance is paced independently, including during catch-up.
                    match store.prune_headers(prune_after).await {
                        Ok((next, _)) => prune_after = next,
                        Err(error) => warn!(
                            domain = store.domain,
                            ?error,
                            "Block header cleanup failed; retrying"
                        ),
                    }
                    sleep(*poll_interval).await;
                }
            },
        );
    }
}

#[cfg(test)]
mod tests;
