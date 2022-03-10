use std::{sync::Arc, time::Duration};

use abacus_base::{CachingInbox, CheckpointSyncer, LocalStorage};
use abacus_core::{AbacusCommon, Inbox};
use color_eyre::Result;
use tokio::{task::JoinHandle, time::sleep};
use tracing::{info, info_span, instrument::Instrumented, Instrument};

pub(crate) struct CheckpointRelayer {
    interval: u64,
    inbox: Arc<CachingInbox>,
}

impl CheckpointRelayer {
    pub(crate) fn new(interval: u64, inbox: Arc<CachingInbox>) -> Self {
        Self { interval, inbox }
    }
    pub(crate) fn spawn(self) -> Instrumented<JoinHandle<Result<()>>> {
        let span = info_span!("CheckpointRelayer");
        let interval = self.interval;
        let local_storage = LocalStorage {
            path: "/tmp/validatorsignatures".to_string(),
        };
        let inbox = self.inbox.clone();
        tokio::spawn(async move {
            let latest_inbox_checkpoint = inbox.latest_checkpoint(None).await?;
            let mut latest_checkpointed_leaf_index = latest_inbox_checkpoint.index;
            let mut current_leaf_index = latest_checkpointed_leaf_index;
            loop {
                 sleep(Duration::from_secs(5)).await;

                if let Some(latest_signed_checkpoint_index) = local_storage.latest_index().await? {
                    if latest_signed_checkpoint_index <= latest_checkpointed_leaf_index {
                      info!(onchain=latest_checkpointed_leaf_index, signed=latest_signed_checkpoint_index, "Signed checkpoint matches known checkpoint on-chain, continue");
                        continue;
                    }
                    // TODO: Check if there are messages between this signed index and the current leaf index
                    let contains_messages = current_leaf_index > 0;
                    // if no messages destined
                    if !contains_messages {
                        info!("New checkpoint does not include messages for inbox");
                        current_leaf_index = latest_signed_checkpoint_index;
                        continue;
                    } else {
                      info!("Signed checkpoint allows for processing of new messages, submit checkpoint");
                        // submit checkpoint
                        if let Some(latest_signed_checkpoint) = local_storage
                            .fetch_checkpoint(latest_signed_checkpoint_index)
                            .await?
                        {
                            inbox.submit_checkpoint(&latest_signed_checkpoint).await?;
                            latest_checkpointed_leaf_index =
                                latest_signed_checkpoint.checkpoint.index;
                            // Sleep after submission
                            sleep(Duration::from_secs(interval)).await;
                        }
                    }
                }
            }
        })
        .instrument(span)
    }
}
