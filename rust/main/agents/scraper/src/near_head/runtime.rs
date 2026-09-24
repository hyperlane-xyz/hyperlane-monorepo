//! One state writer per chain. RPC work remains asynchronous, but observation,
//! publication and ingestion never contend for the same `scraper_head` row.
use std::{sync::Arc, time::Duration};

use hyperlane_base::{ChainMetrics, ContractSyncMetrics};
use hyperlane_core::{HyperlaneDomain, ReorgPeriod};
use tokio::time::sleep;
use tracing::warn;

use super::{
    confirm_leased, confirmation_lease, ingest_cached, observe, source::Source, store::Store,
};

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

/// A completed cycle: whether to run again at once, and whether ingestion failed
/// while existing work still published.
#[derive(Debug)]
pub(super) struct CycleOutcome {
    pub more: bool,
    pub ingestion_failed: bool,
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
        let mut count_cache = None;
        loop {
            let result = self.cycle(&mut count_cache).await;
            // A failed log fetch stays critical even while confirmed pages keep
            // draining without waiting for the next poll.
            let critical = result
                .as_ref()
                .map_or(true, |outcome| outcome.ingestion_failed);
            self.chain_metrics
                .set_critical_error(self.domain.name(), critical);
            match result {
                Ok(CycleOutcome { more: true, .. }) => continue,
                Ok(CycleOutcome { more: false, .. }) => {}
                Err(error) => warn!(
                    domain = self.store.domain,
                    ?error,
                    "Near-head indexing paused; retrying"
                ),
            }
            sleep(self.poll_interval).await;
        }
    }

    async fn cycle(
        &self,
        count_cache: &mut Option<(ethers::types::H256, [u32; 2])>,
    ) -> eyre::Result<CycleOutcome> {
        self.store
            .claim(confirmation_lease(self.poll_interval))
            .await?;
        let observed = match observe(self.source.as_ref(), &self.store).await {
            Ok(state) => state,
            Err(error) => {
                self.store.pause(false).await?;
                return Err(error);
            }
        };
        // Ingest before publication so newly indexed events do not wait for the
        // next poll. Keep the result so existing work can still publish when
        // the log query fails.
        let depth = match &self.period {
            ReorgPeriod::Blocks(depth) => u64::from(depth.get()),
            _ => 0,
        };
        let mut bounded = observed.clone();
        bounded.head = bounded.head.min(
            bounded
                .confirmed
                .saturating_add(depth)
                .saturating_add(10_000),
        );
        let ingestion = if bounded.indexed < bounded.head {
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
        if let Err(error) = &ingestion {
            warn!(
                domain = self.store.domain,
                phase = "ingestion",
                ?error,
                "Near-head indexing phase failed"
            );
        }

        let confirmation = confirm_leased(
            self.source.as_ref(),
            &self.store,
            &self.period,
            confirmation_lease(self.poll_interval),
        )
        .await?;
        for (label, count) in [
            "raw_message_dispatch",
            "message_delivery",
            "gas_payment",
            "merkle_tree_insertion",
        ]
        .into_iter()
        .zip(confirmation.counts)
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

        // Keep draining confirmed pages while logs fail; the failure was logged
        // above and stays visible through the critical-error metric.
        if confirmation.page_limited {
            return Ok(CycleOutcome {
                more: true,
                ingestion_failed: ingestion.is_err(),
            });
        }
        let more_ingestion = ingestion?;
        let capped_head = observed
            .head
            .min(state.confirmed.saturating_add(depth).saturating_add(10_000));
        let at_provisional_cap = capped_head < observed.head && state.indexed >= capped_head;
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
}

#[cfg(test)]
mod tests;
