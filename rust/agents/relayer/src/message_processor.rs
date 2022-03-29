use std::{
    collections::{binary_heap, BinaryHeap},
    sync::Arc,
    time::{Duration, Instant},
};

use abacus_base::CachingInbox;
use abacus_core::{db::AbacusDB, AbacusCommon, CommittedMessage, Inbox, MessageStatus};
use color_eyre::{eyre::bail, Result};
use tokio::{task::JoinHandle, time::sleep};
use tracing::{debug, error, info, info_span, instrument::Instrumented, warn, Instrument};

use crate::merkle_tree_builder::MerkleTreeBuilder;

pub(crate) struct MessageProcessor {
    polling_interval: u64,
    max_retries: u32,
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
    retries: u32,
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
        max_retries: u32,
        db: AbacusDB,
        reorg_period: u64,
        inbox: Arc<CachingInbox>,
    ) -> Self {
        Self {
            polling_interval,
            max_retries,
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

                        match self.prover_sync.get_proof(message_leaf_index) {
                            Ok(proof) => {
                                match self.inbox.prove_and_process(&message.message, &proof).await {
                                    Ok(outcome) => {
                                        info!(
                                            leaf_index = message_leaf_index,
                                            hash = ?outcome.txid,
                                            "[MessageProcessor] processed"
                                        );
                                        self.db.store_leaf_processing_status(message_leaf_index)?;
                                        Ok(MessageProcessingStatus::Processed)
                                    }
                                    Err(err) => {
                                        error!(leaf_index = message_leaf_index, error=?err, "MessageProcessor failed processing, enqueue for retry");
                                        Ok(MessageProcessingStatus::Error)
                                    }
                                }
                            }
                            Err(err) => {
                                error!(error=?err, "MessageProcessor was unable to fetch proof");
                                bail!("MessageProcessor was unable to fetch proof");
                            }
                        }
                    }
                    MessageStatus::Proven => match self.inbox.process(&message.message).await {
                        Ok(outcome) => {
                            info!(
                                leaf_index = message_leaf_index,
                                hash = ?outcome.txid,
                                "[MessageProcessor] processed a message that was already proven"
                            );
                            self.db.store_leaf_processing_status(message_leaf_index)?;
                            Ok(MessageProcessingStatus::Processed)
                        }
                        Err(err) => {
                            error!(leaf_index = message_leaf_index, error=?err, "MessageProcessor failed processing, enqueue for retry");
                            Ok(MessageProcessingStatus::Error)
                        }
                    },
                    MessageStatus::Processed => {
                        debug!(
                            leaf_index = message_leaf_index,
                            domain = self.inbox.local_domain(),
                            "Already processed"
                        );
                        self.db.store_leaf_processing_status(message_leaf_index)?;
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

    pub(crate) fn spawn(mut self) -> Instrumented<JoinHandle<Result<()>>> {
        let span = info_span!("MessageProcessor");

        let mut message_leaf_index = 0;
        tokio::spawn(async move {
            loop {
                if self.db.retrieve_leaf_processing_status(message_leaf_index)?.is_some() {
                    message_leaf_index += 1;
                    continue
                }
                match self.db.leaf_by_leaf_index(message_leaf_index)? {
                    Some(_) => {
                        // We have unseen messages to process
                        info!(
                            destination = self.inbox.local_domain(),
                            leaf_index=message_leaf_index,
                            "Process fresh leaf"
                        );
                        match self.try_processing_message(message_leaf_index).await? {
                            MessageProcessingStatus::Processed => message_leaf_index += 1,
                            MessageProcessingStatus::NotYetCheckpointed => {
                                sleep(Duration::from_secs(self.reorg_period)).await;
                            }
                            MessageProcessingStatus::NotDestinedForInbox => message_leaf_index += 1,
                            MessageProcessingStatus::Error => {
                                warn!(destination = self.inbox.local_domain(), leaf_index=message_leaf_index, "Message could not be processed, queue for retry");
                                self.retry_queue
                                    .push(MessageToRetry {
                                        leaf_index: message_leaf_index,
                                        time_to_retry: Instant::now(),
                                        retries: 0,
                                    });
                                message_leaf_index += 1;
                            }
                        }
                    }
                    None => {
                        // See if we have messages to retry
                        match self.retry_queue.pop() {
                            Some(MessageToRetry { time_to_retry: _, leaf_index, retries }) => {
                                info!(
                                    destination = self.inbox.local_domain(),
                                    leaf_index = leaf_index,
                                    retries = retries,
                                    retry_queue_length = self.retry_queue.len(),
                                    "Retry processing of message"
                                );
                                match self.try_processing_message(leaf_index).await? {
                                MessageProcessingStatus::NotDestinedForInbox | MessageProcessingStatus::NotYetCheckpointed => {
                                    error!(leaf_index = leaf_index, "Somehow we tried to retry a message that cant be retried");
                                    bail!("Somehow we tried to retry a message that cant be retried")
                                }
                                MessageProcessingStatus::Processed => {},
                                MessageProcessingStatus::Error => {
                                    warn!(
                                        destination = self.inbox.local_domain(),
                                        leaf_index = leaf_index,
                                        retries = retries,
                                        retry_queue_length = self.retry_queue.len(),
                                        "Retry of message failed processing"
                                    );
                                    if retries > self.max_retries {
                                        error!(
                                            destination = self.inbox.local_domain(),
                                            leaf_index = leaf_index,
                                            retries = retries,
                                            retry_queue_length = self.retry_queue.len(),
                                            "Maximum number of retries exceeded for processing message"
                                        );
                                        continue
                                    }
                                    let retries = retries + 1;
                                    let time_to_retry = Instant::now() + Duration::from_secs(2u64.pow(retries as u32));
                                    self.retry_queue
                                        .push(MessageToRetry{ leaf_index, time_to_retry, retries});
                                },
                            }
                        },
                            None => {
                                // Nothing to do, just sleep
                                sleep(Duration::from_secs(1)).await;
                            }
                        }
                    }
                }

                // Sleep to not fire too many view calls in a short duration
                sleep(Duration::from_millis(20)).await;
            }
        })
        .instrument(span)
    }
}
