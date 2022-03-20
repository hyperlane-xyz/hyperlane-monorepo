use std::{sync::Arc, time::{Duration, SystemTime}};

use abacus_base::CachingOutbox;
use abacus_core::{AbacusCommon, Checkpoint, Outbox};

use color_eyre::Result;
use tokio::{task::JoinHandle, time::sleep};
use tracing::{info, info_span, instrument::Instrumented, Instrument};

pub(crate) struct CheckpointSubmitter {
    outbox: Arc<CachingOutbox>,
    /// Polling interval in seconds
    interval: Duration,
    // Minimum seconds between submitted checkpoints
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
            // This is just some dummy code
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
                // the latest checkpoint index and a new checkpoint should be made
                if count > latest_checkpoint_index {
                    match self.last_checkpoint_time {
                        Some(last_checkpoint_time) => {
                            if let Ok(elapsed) = last_checkpoint_time.elapsed() {
                                if elapsed >= self.latency {
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
        self.outbox.create_checkpoint().await?;
        self.last_checkpoint_time = Some(SystemTime::now());
        Ok(())
    }
}
