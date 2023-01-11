use std::num::NonZeroU64;
use std::sync::Arc;
use std::time::{Duration, Instant};

use eyre::Result;
use prometheus::IntGauge;
use tokio::{task::JoinHandle, time::sleep};
use tracing::{debug, info, info_span, instrument::Instrumented, Instrument};

use hyperlane_base::{CheckpointSyncer, CoreMetrics};
use hyperlane_core::{Announcement, HyperlaneDomain, HyperlaneSigner, HyperlaneSignerExt, Mailbox};

pub(crate) struct ValidatorSubmitter {
    interval: Duration,
    reorg_period: Option<NonZeroU64>,
    signer: Arc<dyn HyperlaneSigner>,
    mailbox: Arc<dyn Mailbox>,
    checkpoint_syncer: Arc<dyn CheckpointSyncer>,
    metrics: ValidatorSubmitterMetrics,
}

impl ValidatorSubmitter {
    pub(crate) fn new(
        interval: Duration,
        reorg_period: u64,
        mailbox: Arc<dyn Mailbox>,
        signer: Arc<dyn HyperlaneSigner>,
        checkpoint_syncer: Arc<dyn CheckpointSyncer>,
        metrics: ValidatorSubmitterMetrics,
    ) -> Self {
        Self {
            reorg_period: NonZeroU64::new(reorg_period),
            interval,
            mailbox,
            signer,
            checkpoint_syncer,
            metrics,
        }
    }

    pub(crate) fn spawn(self) -> Instrumented<JoinHandle<Result<()>>> {
        let span = info_span!("ValidatorSubmitter");
        tokio::spawn(async move { self.main_task().await }).instrument(span)
    }

    async fn main_task(self) -> Result<()> {
        // Sign and post the validator announcement
        let announcement = Announcement {
            mailbox_address: self.mailbox.address(),
            mailbox_domain: self.mailbox.domain().id(),
            storage_metadata: self.checkpoint_syncer.announcement_metadata(),
        };
        let signed_announcement = self.signer.sign(announcement).await?;
        self.checkpoint_syncer
            .write_announcement(&signed_announcement)
            .await?;

        // Ensure that the mailbox has > 0 messages before we enter the main
        // validator submit loop. This is to avoid an underflow / reverted
        // call when we invoke the `mailbox.latest_checkpoint()` method,
        // which returns the **index** of the last element in the tree
        // rather than just the size.  See
        // https://github.com/hyperlane-network/hyperlane-monorepo/issues/575 for
        // more details.
        while self.mailbox.count().await? == 0 {
            info!("Waiting for non-zero mailbox size");
            sleep(self.interval).await;
        }

        // current_index will be None if the validator cannot find
        // a previously signed checkpoint
        let mut current_index = self.checkpoint_syncer.latest_index().await?;

        if let Some(current_index) = current_index {
            self.metrics
                .latest_checkpoint_processed
                .set(current_index as i64);
        }

        // How often to log checkpoint info - once every minute
        let checkpoint_info_log_period = Duration::from_secs(60);
        // The instant in which we last logged checkpoint info, if at all
        let mut latest_checkpoint_info_log: Option<Instant> = None;
        // Returns whether checkpoint info should be logged based off the
        // checkpoint_info_log_period having elapsed since the last log.
        // Sets latest_checkpoint_info_log to the current instant if true.
        let mut should_log_checkpoint_info = || {
            if let Some(instant) = latest_checkpoint_info_log {
                if instant.elapsed() < checkpoint_info_log_period {
                    return false;
                }
            }
            latest_checkpoint_info_log = Some(Instant::now());
            true
        };

        info!(current_index = current_index, "Starting Validator");
        loop {
            // Check the latest checkpoint
            let latest_checkpoint = self.mailbox.latest_checkpoint(self.reorg_period).await?;

            self.metrics
                .latest_checkpoint_observed
                .set(latest_checkpoint.index as i64);

            // Occasional info to make it clear to a validator operator whether things are working
            // correctly without using the debug log level.
            if should_log_checkpoint_info() {
                info!(
                    latest_signed_checkpoint_index=?current_index,
                    latest_known_checkpoint_index=?latest_checkpoint.index,
                    "Latest checkpoint infos"
                );
            }

            debug!(
                latest_signed_checkpoint_index=?current_index,
                latest_known_checkpoint_index=?latest_checkpoint.index,
                "Polled latest checkpoint"
            );

            // If current_index is None, we were unable to find a previously
            // signed checkpoint, and we should sign the latest checkpoint.
            // This ensures that we still sign even if the latest checkpoint
            // has index 0.
            if current_index
                .map(|i| i < latest_checkpoint.index)
                .unwrap_or(true)
            {
                let signed_checkpoint = self.signer.sign(latest_checkpoint).await?;

                info!(signed_checkpoint = ?signed_checkpoint, signer=?self.signer, "Signed new latest checkpoint");
                current_index = Some(latest_checkpoint.index);

                self.checkpoint_syncer
                    .write_checkpoint(&signed_checkpoint)
                    .await?;
                self.metrics
                    .latest_checkpoint_processed
                    .set(signed_checkpoint.value.index as i64);
            }

            sleep(self.interval).await;
        }
    }
}

pub(crate) struct ValidatorSubmitterMetrics {
    latest_checkpoint_observed: IntGauge,
    latest_checkpoint_processed: IntGauge,
}

impl ValidatorSubmitterMetrics {
    pub fn new(metrics: &CoreMetrics, mailbox_chain: &HyperlaneDomain) -> Self {
        let chain_name = mailbox_chain.name();
        Self {
            latest_checkpoint_observed: metrics
                .latest_checkpoint()
                .with_label_values(&["validator_observed", chain_name]),
            latest_checkpoint_processed: metrics
                .latest_checkpoint()
                .with_label_values(&["validator_processed", chain_name]),
        }
    }
}
