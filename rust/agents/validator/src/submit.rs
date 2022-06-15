use std::sync::Arc;
use std::time::Duration;

use tokio::{task::JoinHandle, time::sleep};
use tracing::{info, info_span, instrument::Instrumented, Instrument};

use abacus_base::{CachingOutbox, CheckpointSyncer, CheckpointSyncers};
use abacus_core::{Outbox, Signers};
use eyre::Result;

pub(crate) struct ValidatorSubmitter {
    interval: u64,
    reorg_period: u64,
    signer: Arc<Signers>,
    outbox: Arc<CachingOutbox>,
    checkpoint_syncer: Arc<CheckpointSyncers>,
}

impl ValidatorSubmitter {
    pub(crate) fn new(
        interval: u64,
        reorg_period: u64,
        outbox: Arc<CachingOutbox>,
        signer: Arc<Signers>,
        checkpoint_syncer: Arc<CheckpointSyncers>,
    ) -> Self {
        Self {
            reorg_period,
            interval,
            outbox,
            signer,
            checkpoint_syncer,
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
            sleep(Duration::from_secs(self.interval)).await;

            // Check the latest checkpoint
            let latest_checkpoint = self.outbox.latest_checkpoint(reorg_period).await?;

            // TODO: add metric here for checkpoint

            if current_index < latest_checkpoint.index {
                let signed_checkpoint = latest_checkpoint.sign_with(self.signer.as_ref()).await?;

                info!(signature = ?signed_checkpoint, signer=?self.signer, "Sign latest checkpoint");
                current_index = latest_checkpoint.index;

                self.checkpoint_syncer
                    .write_checkpoint(signed_checkpoint.clone())
                    .await?;
                // TODO: add metric for last written checkpoint
            }
        }
    }
}
