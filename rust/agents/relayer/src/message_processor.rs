use std::{
    collections::{binary_heap, BinaryHeap},
    sync::Arc,
    time::{Duration, Instant},
};

use abacus_base::CachingInbox;
use abacus_core::{db::AbacusDB, AbacusCommon, CommittedMessage, Inbox, MessageStatus};
use color_eyre::{eyre::bail, Result};
use tokio::{task::JoinHandle, time::sleep};
use tracing::{debug, error, info, info_span, instrument::Instrumented, Instrument};

use crate::merkle_tree_builder::MerkleTreeBuilder;

pub(crate) struct MessageProcessor {
    polling_interval: u64,
    reorg_period: u64,
    db: AbacusDB,
    inbox: Arc<CachingInbox>,
    prover_sync: MerkleTreeBuilder,
    retry_queue: BinaryHeap<MessageToRetry>,
}

#[derive(PartialEq, Eq, PartialOrd, Ord)]
struct MessageToRetry {
    time_to_retry: Instant,
    leaf_index: u32,
    retries: usize,
}

enum MessageProcessingStatus {
    NotDestinedForInbox,
    NotYetCheckpointed,
    Processed,
    Error,
}

impl MessageProcessor {
    pub(crate) fn new(
        polling_interval: u64,
        db: AbacusDB,
        reorg_period: u64,
        inbox: Arc<CachingInbox>,
    ) -> Self {
        Self {
            polling_interval,
            reorg_period,
            prover_sync: MerkleTreeBuilder::new(db.clone()),
            db,
            inbox,
            retry_queue: BinaryHeap::new(),
        }
    }

    async fn try_processing_message(
        &mut self,
        message_leaf_index: u32,
    ) -> Result<MessageProcessingStatus> {
        match self
            .db
            .message_by_leaf_index(message_leaf_index)?
            .map(CommittedMessage::try_from)
            .transpose()?
        {
            Some(message) => {
                let leaf = message.to_leaf();
                if message.message.destination != self.inbox.local_domain() {
                    return Ok(MessageProcessingStatus::NotDestinedForInbox);
                }
                // TODO: Figure out how to prevent races with the relayers message processing
                match self.inbox.message_status(leaf).await? {
                    MessageStatus::None => {
                        if message_leaf_index >= self.prover_sync.count() {
                            // gotta find a root that includes the message
                            let latest_checkpoint = self
                                .inbox
                                .latest_checkpoint(Some(self.reorg_period))
                                .await?;

                            self.prover_sync
                                .update_to_checkpoint(&latest_checkpoint)
                                .await?;

                            if message_leaf_index >= self.prover_sync.count() {
                                // If we don't have an up to date checkpoint, sleep and try again
                                return Ok(MessageProcessingStatus::NotYetCheckpointed);
                            }
                        }

                        // TODO: Don't fetch the proof from DB to avoid races with the relayer
                        if let Some(proof) = self.db.proof_by_leaf_index(message_leaf_index)? {
                            // TODO: This is probably unnecessary but we should consider checking that the proof is still valid. Really,
                            match self.inbox.prove_and_process(&message.message, &proof).await {
                                Ok(outcome) => {
                                    info!(
                                        leaf_index = message_leaf_index,
                                        hash = ?outcome.txid,
                                        "[MessageProcessor] processed"
                                    );
                                    Ok(MessageProcessingStatus::Processed)
                                }
                                Err(err) => {
                                    error!(leaf_index = message_leaf_index, error=?err, "MessageProcessor failed processing, enqueue for retry");
                                    Ok(MessageProcessingStatus::Error)
                                }
                            }
                        } else {
                            // Should not get here since we thought it was processable,
                            // but we couldn't find the proof
                            bail!("Somehow MessageProcessor did not get the proof");
                        }
                    }
                    // TODO: Remove this as we don't separately prove and process
                    MessageStatus::Proven => {
                        self.inbox.process(&message.message).await?;
                        Ok(MessageProcessingStatus::Processed)
                    }
                    MessageStatus::Processed => {
                        debug!(
                            leaf_index = message_leaf_index,
                            domain = self.inbox.local_domain(),
                            "Already processed"
                        );
                        Ok(MessageProcessingStatus::Processed)
                    }
                }
            }
            None => {
                // Should not get here
                bail!("Somehow MessageProcessor get the leaf despite waiting for it");
            }
        }
    }

    fn calculate_next_retry(
        maybe_message_to_retry: Option<MessageToRetry>,
        leaf_index: u32,
    ) -> MessageToRetry {
        match maybe_message_to_retry {
            Some(message_to_retry) => message_to_retry,
            None => MessageToRetry {
                leaf_index,
                time_to_retry: Instant::now(),
                retries: 0,
            },
        }
    }

    pub(crate) fn spawn(mut self) -> Instrumented<JoinHandle<Result<()>>> {
        let span = info_span!("MessageProcessor");

        let mut message_leaf_index = 0;
        tokio::spawn(async move {
            loop {
                // check for message status
                self.db.wait_for_leaf(message_leaf_index).await?;
                match self.try_processing_message(message_leaf_index).await? {
                    MessageProcessingStatus::Processed => message_leaf_index += 1,
                    MessageProcessingStatus::NotYetCheckpointed => {
                        sleep(Duration::from_secs(self.reorg_period)).await;
                    }
                    MessageProcessingStatus::NotDestinedForInbox => message_leaf_index += 1,
                    MessageProcessingStatus::Error => {
                        self.retry_queue
                            .push(MessageProcessor::calculate_next_retry(
                                None,
                                message_leaf_index,
                            ));
                        message_leaf_index += 1;
                    }
                }
            }
        })
        .instrument(span)
    }
}
