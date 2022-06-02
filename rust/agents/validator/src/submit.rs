use std::sync::Arc;
use std::time::Duration;

use tokio::{task::JoinHandle, time::sleep};
use tracing::{info, info_span, instrument::Instrumented, Instrument};

use abacus_base::{CachingOutbox, CheckpointSyncer, CheckpointSyncers};
use abacus_core::{AbacusCommon, Signers};
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
        let reorg_period = Some(self.reorg_period);
        tokio::spawn(async move {
            let mut current_index = self.checkpoint_syncer.latest_index().await?.unwrap_or_default();

            info!(current_index=current_index, "Starting Validator");
            loop {
                sleep(Duration::from_secs(self.interval)).await;

                // Check the current checkpoint
                let checkpoint = self.outbox.latest_cached_checkpoint(reorg_period).await?;

                if current_index < checkpoint.index {
                    let signed_checkpoint = checkpoint.sign_with(self.signer.as_ref()).await?;

                    info!(signature = ?signed_checkpoint, signer=?self.signer, "Sign latest checkpoint");
                    current_index = checkpoint.index;

                    self.checkpoint_syncer.write_checkpoint(signed_checkpoint.clone()).await?;
                }
            }
        })
            .instrument(span)
    }
}
