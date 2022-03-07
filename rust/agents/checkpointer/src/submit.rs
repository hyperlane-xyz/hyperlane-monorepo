use std::sync::Arc;

use abacus_base::CachingOutbox;
use abacus_core::{db::AbacusDB, AbacusCommon, CommittedMessage, Common};
use std::time::Duration;

use color_eyre::Result;
use tokio::{task::JoinHandle, time::sleep};
use tracing::{info, info_span, instrument::Instrumented, Instrument};

pub(crate) struct CheckpointSubmitter {
    outbox: Arc<CachingOutbox>,
    db: AbacusDB,
    interval_seconds: u64,
}

impl CheckpointSubmitter {
    pub(crate) fn new(outbox: Arc<CachingOutbox>, db: AbacusDB, interval_seconds: u64) -> Self {
        Self {
            outbox,
            db,
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
                let root = self.outbox.checkpointed_root().await?;

                info!(root=?root, "Checked root");

                // Get the latest message
                if let Some(leaf) = self.db.retrieve_latest_leaf_index()? {
                    if let Some(message) = self.db.message_by_leaf_index(leaf)? {
                        let parsed_message = CommittedMessage::try_from(message)?;
                        info!(parsed_message=?parsed_message, "Latest leaf");

                        if let Some(update) = self
                            .db
                            .update_by_previous_root(parsed_message.committed_root)?
                        {
                            // Check if we want to submit a checkpoint tx
                            if parsed_message.committed_root == update.update.previous_root {
                                info!("Submit checkpoint");
                            }
                        }
                    }
                }
            }
        })
        .instrument(span)
    }
}
