use std::sync::Arc;

use abacus_base::{CachingOutbox, CheckpointSyncer, LocalStorage};
use abacus_core::{AbacusCommon, Signers};
use std::time::Duration;

use color_eyre::Result;
use tokio::{task::JoinHandle, time::sleep};
use tracing::{info, info_span, instrument::Instrumented, Instrument};
pub(crate) struct ValidatorSubmitter {
    interval: u64,
    reorg_period: u8,
    signer: Arc<Signers>,
    outbox: Arc<CachingOutbox>,
}

impl ValidatorSubmitter {
    pub(crate) fn new(
        interval: u64,
        reorg_period: u8,
        outbox: Arc<CachingOutbox>,
        signer: Arc<Signers>,
    ) -> Self {
        Self {
            reorg_period,
            interval,
            outbox,
            signer,
        }
    }

    pub(crate) fn spawn(self) -> Instrumented<JoinHandle<Result<()>>> {
        let span = info_span!("ValidatorSubmitter");
        let reorg_period = self.reorg_period;
        tokio::spawn(async move {
            let starting_checkpoint = self.outbox.latest_checkpoint(Some(reorg_period)).await?;
            let mut current_index = starting_checkpoint.index;
            loop {
                sleep(Duration::from_secs(self.interval)).await;

                // Check the current checkpoint
                let checkpoint = self.outbox.latest_checkpoint(Some(reorg_period)).await?;

                if current_index < checkpoint.index {
                    let signed_checkpoint = checkpoint.sign_with(self.signer.as_ref()).await?;

                    info!(signature = ?signed_checkpoint, signer=?self.signer, "New checkpoint, sign!!");
                    current_index = checkpoint.index;

                    let storage = LocalStorage { path: "/tmp/validatorsignatures".to_string() };
                    storage.write_checkpoint(signed_checkpoint).await?;
                }
            }
        })
        .instrument(span)
    }
}
