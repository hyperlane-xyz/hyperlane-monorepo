use std::num::NonZeroU64;
use std::sync::Arc;
use std::time::{Duration, Instant};

use eyre::Result;
use prometheus::IntGauge;
use tokio::{task::JoinHandle, time::sleep};
use tracing::{error, debug, info, info_span, instrument::Instrumented, warn, Instrument};

use hyperlane_base::{CheckpointSyncer, CoreMetrics};
use hyperlane_core::{
    Announcement, HyperlaneDomain, HyperlaneSigner, HyperlaneSignerExt, Mailbox, ValidatorAnnounce,
    H256, U256,
};

pub(crate) struct ValidatorSubmitter {
    interval: Duration,
    reorg_period: Option<NonZeroU64>,
    signer: Arc<dyn HyperlaneSigner>,
    mailbox: Arc<dyn Mailbox>,
    validator_announce: Arc<dyn ValidatorAnnounce>,
    checkpoint_syncer: Arc<dyn CheckpointSyncer>,
    metrics: ValidatorSubmitterMetrics,
}

impl ValidatorSubmitter {
    pub(crate) fn new(
        interval: Duration,
        reorg_period: u64,
        mailbox: Arc<dyn Mailbox>,
        validator_announce: Arc<dyn ValidatorAnnounce>,
        signer: Arc<dyn HyperlaneSigner>,
        checkpoint_syncer: Arc<dyn CheckpointSyncer>,
        metrics: ValidatorSubmitterMetrics,
    ) -> Self {
        Self {
            reorg_period: NonZeroU64::new(reorg_period),
            interval,
            mailbox,
            validator_announce,
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
            validator: self.signer.eth_address(),
            mailbox_address: self.mailbox.address(),
            mailbox_domain: self.mailbox.domain().id(),
            storage_location: self.checkpoint_syncer.announcement_location(),
        };
        let signed_announcement = self.signer.sign(announcement.clone()).await?;
        self.checkpoint_syncer
            .write_announcement(&signed_announcement)
            .await?;

        // Ensure that the validator has announced themselves before we enter
        // the main validator submit loop. This is to avoid a situation in
        // which the validator is signing checkpoints but has not announced
        // their locations, which makes them functionally unusable.
        let validators: [H256; 1] = [self.signer.eth_address().into()];
        loop {
            warn!("Checking for validator announcement");
            if let Some(locations) = self
                .validator_announce
                .get_announced_storage_locations(&validators)
                .await?
                .first()
            {
                if locations.contains(&self.checkpoint_syncer.announcement_location()) {
                    info!("Validator has announced signature storage location");
                    break;
                }
                info!("Validator has not announced signature storage location");
                let balance_delta = self.validator_announce.announce_tokens_needed(signed_announcement.clone()).await?;
                if balance_delta.cmp(&U256::zero()) == std::cmp::Ordering::Greater {
                    warn!(
                        "Please send {} tokens to the validator address {} to announce",
                        balance_delta, announcement.validator,
                    );
                } else {
                    let outcome = self
                        .validator_announce
                        .announce(signed_announcement.clone(), None)
                        .await?;
                    if !outcome.executed {
                        error!(
                            hash=?outcome.txid,
                            "Transaction attempting to announce validator reverted"
                        );
                    }
                }
            }
            sleep(self.interval).await;
        }

        // Ensure that the mailbox has > 0 messages before we enter the main
        // validator submit loop. This is to avoid an underflow / reverted
        // call when we invoke the `mailbox.latest_checkpoint()` method,
        // which returns the **index** of the last element in the tree
        // rather than just the size.  See
        // https://github.com/hyperlane-network/hyperlane-monorepo/issues/575 for
        // more details.
        while self.mailbox.count(self.reorg_period).await? == 0 {
            info!("Waiting for first message to mailbox");
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

            // Occasional info to make it clear to a validator operator whether things are
            // working correctly without using the debug log level.
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
