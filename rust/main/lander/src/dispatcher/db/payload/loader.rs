use std::{
    fmt::{Debug, Formatter},
    sync::Arc,
    time::Instant,
};

use derive_new::new;
use tracing::info;

use crate::{
    dispatcher::{metrics::DispatcherMetrics, BuildingStageQueue},
    error::LanderError,
};

use super::PayloadDb;

// Bound each synchronous chunk to at most 2,000 point reads and 1,000 derived
// writes while amortizing one RocksDB commit across the whole chunk.
const RECONCILIATION_BATCH_SIZE: u32 = 1_000;
const TASK_NAME: &str = "PayloadDbLoader";

#[derive(new)]
pub struct PayloadDbLoader {
    db: Arc<dyn PayloadDb>,
    building_stage_queue: BuildingStageQueue,
    domain: String,
}

impl PayloadDbLoader {
    pub async fn load_from_db(&self, metrics: DispatcherMetrics) -> Result<(), LanderError> {
        let started_at = Instant::now();
        metrics.update_liveness_metric(TASK_NAME, &self.domain);

        let checkpoint = self.db.pending_payload_index_checkpoint().await?;
        let requires_reconciliation = match checkpoint {
            Some(checkpoint) => {
                self.db
                    .pending_payload_index_requires_reconciliation(checkpoint)
                    .await?
            }
            None => true,
        };

        if !requires_reconciliation {
            let payloads = self.db.retrieve_pending_payloads().await?;
            let count = payloads.len();
            self.building_stage_queue.extend(payloads).await;
            info!(
                count,
                elapsed_ms = started_at.elapsed().as_millis(),
                domain = %self.domain,
                "Loaded pending payload index"
            );
            metrics.remove_liveness_metric(TASK_NAME, &self.domain);
            return Ok(());
        }

        let highest_index = self.db.retrieve_highest_payload_index().await?;
        info!(
            highest_index,
            domain = %self.domain,
            "Backfilling pending payload index"
        );
        self.db.begin_pending_payload_index_reconciliation().await?;
        let mut pending_count = 0usize;
        let mut last_index = highest_index;
        while last_index > 0 {
            let first_index = last_index
                .saturating_sub(RECONCILIATION_BATCH_SIZE.saturating_sub(1))
                .max(1);
            let payloads = self
                .db
                .reconcile_pending_payloads(first_index, last_index)
                .await?;
            pending_count = pending_count.saturating_add(payloads.len());
            self.building_stage_queue.extend(payloads).await;
            metrics.update_liveness_metric(TASK_NAME, &self.domain);

            if first_index == 1 {
                break;
            }
            last_index = first_index.saturating_sub(1);
            tokio::task::yield_now().await;
        }
        self.db.mark_pending_payload_index_reconciled().await?;
        info!(
            highest_index,
            pending_count,
            elapsed_ms = started_at.elapsed().as_millis(),
            domain = %self.domain,
            "Pending payload index backfill complete"
        );
        metrics.remove_liveness_metric(TASK_NAME, &self.domain);
        Ok(())
    }
}

impl Debug for PayloadDbLoader {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PayloadDbLoader").finish()
    }
}
