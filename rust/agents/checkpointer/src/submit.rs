use std::sync::Arc;

use abacus_base::CachingOutbox;
use abacus_core::{AbacusCommon, Checkpoint, Outbox};
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

                // Check the latest checkpointed index
                let Checkpoint { index: latest_checkpoint_index, .. } = self.outbox.latest_checkpoint().await?;
                // Get the current count of the tree
                let count = self.outbox.count().await?;

                info!(
                    latest_checkpoint_index=?latest_checkpoint_index,
                    count=?count,
                    "Got latest checkpoint and count"
                );
                // If there are any new messages, the count will be greater than
                // the latest checkpoint index and a new checkpoint should be made
                if count > latest_checkpoint_index {
                    self.outbox.create_checkpoint().await?;
                }
            }
        })
        .instrument(span)
    }
}
