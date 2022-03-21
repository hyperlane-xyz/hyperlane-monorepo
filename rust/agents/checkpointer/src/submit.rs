use std::{
    sync::Arc,
    time::{Duration, SystemTime},
};

use abacus_base::CachingOutbox;
use abacus_core::{AbacusCommon, Checkpoint, Outbox};

use color_eyre::Result;
use tokio::{task::JoinHandle, time::sleep};
use tracing::{debug, info, info_span, instrument::Instrumented, Instrument};

pub(crate) struct CheckpointSubmitter {
    outbox: Arc<CachingOutbox>,
    /// The polling interval (in seconds)
    interval: Duration,
    /// The minimum period between submitted checkpoints (in seconds)
    latency: Duration,
    /// The time at which the last checkpoint was submitted
    last_checkpoint_time: Option<SystemTime>,
}

impl CheckpointSubmitter {
    pub(crate) fn new(outbox: Arc<CachingOutbox>, interval: u64, latency: u64) -> Self {
        Self {
            outbox,
            interval: Duration::from_secs(interval),
            latency: Duration::from_secs(latency),
            last_checkpoint_time: None,
        }
    }

    pub(crate) fn spawn(mut self) -> Instrumented<JoinHandle<Result<()>>> {
        let span = info_span!("CheckpointSubmitter");

        tokio::spawn(async move {
            loop {
                sleep(self.interval).await;

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
                // To prevent creating checkpoints too frequently, a new checkpoint
                // should be made if `latency` has elapsed since the last created
                // checkpoint.
                if count > latest_checkpoint_index {
                    match self.last_checkpoint_time {
                        Some(last_checkpoint_time) => {
                            if let Ok(elapsed) = last_checkpoint_time.elapsed() {
                                let can_create_checkpoint = elapsed >= self.latency;
                                debug!(
                                    elapsed=?elapsed,
                                    can_create_checkpoint=?can_create_checkpoint,
                                    "Got elapsed duration from last checkpoint"
                                );
                                if can_create_checkpoint {
                                    self.create_checkpoint().await?
                                }
                            }
                        }
                        None => self.create_checkpoint().await?,
                    }
                }
            }
        })
        .instrument(span)
    }

    async fn create_checkpoint(&mut self) -> Result<()> {
        debug!("Creating checkpoint");
        self.outbox.create_checkpoint().await?;
        self.last_checkpoint_time = Some(SystemTime::now());
        Ok(())
    }
}
