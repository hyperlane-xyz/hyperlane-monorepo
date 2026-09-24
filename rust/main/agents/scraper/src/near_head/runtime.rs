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

impl Worker {
    pub async fn run(&self) {
        let mut count_cache = None;
        loop {
            let result = self.cycle(&mut count_cache).await;
            self.chain_metrics
                .set_critical_error(self.domain.name(), result.is_err());
            match result {
                Ok(true) => continue,
                Ok(false) => {}
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
    ) -> eyre::Result<bool> {
        let observed = match observe(self.source.as_ref(), &self.store).await {
            Ok(state) => state,
            Err(error) => {
                self.store.pause(false).await?;
                return Err(error);
            }
        };
        self.sync_metrics
            .indexed_height
            .with_label_values(&["near_head", self.domain.name()])
            .set(i64::try_from(observed.indexed)?);

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

        Ok(ingestion? || confirmation.page_limited)
    }
}

#[cfg(test)]
mod tests;
