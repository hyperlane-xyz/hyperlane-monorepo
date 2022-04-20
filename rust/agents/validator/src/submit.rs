use std::sync::Arc;

use abacus_base::{CachingOutbox, CheckpointSyncer, CheckpointSyncers};
use abacus_core::{AbacusCommon, Signers};
use std::time::Duration;

use color_eyre::Result;
use tokio::{task::JoinHandle, time::sleep};
use tracing::{info, info_span, instrument::Instrumented, Instrument};
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
            let mut maybe_current_index = self.checkpoint_syncer.latest_index().await?;
            loop {
                sleep(Duration::from_secs(self.interval)).await;

                // Check the current checkpoint
                let checkpoint = self.outbox.latest_checkpoint(reorg_period).await?;

                if maybe_current_index.map_or(true, |current_index| current_index < checkpoint.index ) && !checkpoint.root.is_zero() {
                    let signed_checkpoint = checkpoint.sign_with(self.signer.as_ref()).await?;

                    info!(signature = ?signed_checkpoint, signer=?self.signer, "Sign latest checkpoint");
                    maybe_current_index = Some(checkpoint.index);

                    self.checkpoint_syncer.write_checkpoint(signed_checkpoint.clone()).await?;
                }
            }
        })
        .instrument(span)
    }
}
