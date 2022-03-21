use std::{sync::Arc, time::Duration};

use abacus_base::CachingOutbox;
use abacus_core::{AbacusCommon, Checkpoint, Outbox};

use color_eyre::Result;
use tokio::{task::JoinHandle, time::sleep};
use tracing::{debug, info, info_span, instrument::Instrumented, Instrument};

pub(crate) struct CheckpointSubmitter {
    outbox: Arc<CachingOutbox>,
    /// The polling interval
    polling_interval: Duration,
    /// The minimum period between submitted checkpoints
    creation_latency: Duration,
}

impl CheckpointSubmitter {
    pub(crate) fn new(
        outbox: Arc<CachingOutbox>,
        polling_interval: u64,
        creation_latency: u64,
    ) -> Self {
        Self {
            outbox,
            polling_interval: Duration::from_secs(polling_interval),
            creation_latency: Duration::from_secs(creation_latency),
        }
    }

    pub(crate) fn spawn(self) -> Instrumented<JoinHandle<Result<()>>> {
        let span = info_span!("CheckpointSubmitter");

        tokio::spawn(async move {
            loop {
                sleep(self.polling_interval).await;

                // Check the latest checkpointed index
                let Checkpoint {
                    index: latest_checkpoint_index,
                    ..
                } = self.outbox.latest_checkpoint(None).await?;
                // Get the current count of the tree
                let count = self.outbox.count().await?;

                info!(
                    latest_checkpoint_index=?latest_checkpoint_index,
                    count=?count,
                    "Got latest checkpoint and count"
                );
                // If there are any new messages, the count will be greater than
                // the latest checkpoint index.
                if count > latest_checkpoint_index {
                    debug!("Creating checkpoint");
                    self.outbox.create_checkpoint().await?;
                    // Sleep to ensure that another checkpoint isn't made until
                    // creation_latency has passed
                    sleep(self.creation_latency).await;
                }
            }
        })
        .instrument(span)
    }
}
