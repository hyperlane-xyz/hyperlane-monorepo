use std::sync::Arc;

use abacus_base::CachingOutbox;
use abacus_core::{AbacusCommon, Outbox};
use std::time::Duration;

use color_eyre::Result;
use tokio::{task::JoinHandle, time::sleep};
use tracing::{info, info_span, instrument::Instrumented, Instrument};

pub(crate) struct CheckpointSubmitter {
    outbox: Arc<CachingOutbox>,
    interval_seconds: u64,
}

impl CheckpointSubmitter {
    pub(crate) fn new(outbox: Arc<CachingOutbox>, interval_seconds: u64) -> Self {
        Self {
            outbox,
            interval_seconds,
        }
    }

    pub(crate) fn spawn(self) -> Instrumented<JoinHandle<Result<()>>> {
        let span = info_span!("CheckpointSubmitter");

        tokio::spawn(async move {
            // This is just some dummy code
            loop {
                sleep(Duration::from_secs(self.interval_seconds)).await;

                // Check the current checkpoint
                let current_checkpointed_root = self.outbox.checkpointed_root().await?;
                // Get the current root of the tree.
                // By comparing this with the checkpoint, we can see if there are any
                // new messages without any indexing. Note that it's possible for
                // messages to be re-orged away that are included in this new root,
                // but this has no major effect beside submitting an unnecessary checkpoint
                // transaction.
                let current_root = self.outbox.root().await?;

                info!(
                    current_checkpointed_root=?current_checkpointed_root,
                    current_root=?current_root,
                    "Got checkpointed root and calculated current root"
                );

                if current_checkpointed_root != current_root {
                    self.outbox.create_checkpoint().await?;
                }
            }
        })
        .instrument(span)
    }
}
