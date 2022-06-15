use std::sync::Arc;
use std::time::Duration;

use eyre::Result;
use prometheus::IntGauge;
use tokio::{task::JoinHandle, time::sleep};
use tracing::warn;
use tracing::{info, info_span, instrument::Instrumented, Instrument};

use abacus_base::{CachingOutbox, CheckpointSyncer, CheckpointSyncers, CoreMetrics};
use abacus_core::{ChainCommunicationError, Outbox, OutboxState, Signers};

pub(crate) struct ValidatorSubmitter {
    interval: u64,
    reorg_period: u64,
    signer: Arc<Signers>,
    outbox: Arc<CachingOutbox>,
    checkpoint_syncer: Arc<CheckpointSyncers>,
    metrics: ValidatorSubmitterMetrics,
}

impl ValidatorSubmitter {
    pub(crate) fn new(
        interval: u64,
        reorg_period: u64,
        outbox: Arc<CachingOutbox>,
        signer: Arc<Signers>,
        checkpoint_syncer: Arc<CheckpointSyncers>,
        metrics: ValidatorSubmitterMetrics,
    ) -> Self {
        Self {
            reorg_period,
            interval,
            outbox,
            signer,
            checkpoint_syncer,
            metrics,
        }
    }

    pub(crate) fn spawn(self) -> Instrumented<JoinHandle<Result<()>>> {
        let span = info_span!("ValidatorSubmitter");
        tokio::spawn(self.main_task()).instrument(span)
    }

    async fn main_task(self) -> Result<()> {
        let reorg_period = Some(self.reorg_period);
        // Ensure that the outbox has > 0 messages before we enter the main
        // validator submit loop. This is to avoid an underflow / reverted
        // call when we invoke the `outbox.latest_checkpoint()` method,
        // which returns the **index** of the last element in the tree
        // rather than just the size.  See
        // https://github.com/abacus-network/abacus-monorepo/issues/575 for
        // more details.
        while self.outbox.count().await? == 0 {
            info!("waiting for non-zero outbox size");
            sleep(Duration::from_secs(self.interval)).await;
        }

        let mut current_index = self
            .checkpoint_syncer
            .latest_index()
            .await?
            .unwrap_or_default();

        info!(current_index = current_index, "Starting Validator");
        loop {
            self.update_outbox_state_gauge();

            // Check the latest checkpoint
            let latest_checkpoint = self.outbox.latest_checkpoint(reorg_period).await?;

            self.metrics
                .latest_checkpoint_observed
                .set(latest_checkpoint.index as i64);

            if current_index < latest_checkpoint.index {
                let signed_checkpoint = latest_checkpoint.sign_with(self.signer.as_ref()).await?;

                info!(signature = ?signed_checkpoint, signer=?self.signer, "Sign latest checkpoint");
                current_index = latest_checkpoint.index;

                self.checkpoint_syncer
                    .write_checkpoint(signed_checkpoint.clone())
                    .await?;
                self.metrics
                    .latest_checkpoint_processed
                    .set(signed_checkpoint.checkpoint.index as i64);
            }

            sleep(Duration::from_secs(self.interval)).await;
        }
    }

    fn update_outbox_state_gauge(
        &self,
    ) -> JoinHandle<Result<OutboxState, ChainCommunicationError>> {
        let outbox_state_gauge = self.metrics.outbox_state.clone();
        let outbox = self.outbox.clone();
        tokio::spawn(async move {
            let state = outbox.state().await;
            match &state {
                Ok(state) => outbox_state_gauge.set(*state as u8 as i64),
                Err(e) => warn!(error = %e, "Failed to get outbox state"),
            };
            state
        })
    }
}

pub(crate) struct ValidatorSubmitterMetrics {
    outbox_state: IntGauge,
    latest_checkpoint_observed: IntGauge,
    latest_checkpoint_processed: IntGauge,
}

impl ValidatorSubmitterMetrics {
    pub fn new(metrics: &CoreMetrics, outbox_chain: &str) -> Self {
        Self {
            outbox_state: metrics.outbox_state().with_label_values(&[outbox_chain]),
            latest_checkpoint_observed: metrics
                .latest_checkpoint()
                .with_label_values(&["validator_observed", outbox_chain]),
            latest_checkpoint_processed: metrics
                .latest_checkpoint()
                .with_label_values(&["validator_processed", outbox_chain]),
        }
    }
}
