use std::{
    cmp::Reverse,
    collections::BinaryHeap,
    sync::Arc,
    time::{Duration, Instant},
};

use abacus_base::{CachingInbox, Outboxes};
use abacus_core::{
    db::AbacusDB, AbacusCommon, AbacusContract, CommittedMessage, Inbox, MessageStatus,
};
use eyre::{bail, Result};
use prometheus::{IntGauge, IntGaugeVec};
use tokio::{task::JoinHandle, time::sleep};
use tracing::{
    debug, error, info, info_span, instrument, instrument::Instrumented, warn, Instrument,
};

use crate::merkle_tree_builder::MerkleTreeBuilder;

pub(crate) struct MessageProcessor {
    polling_interval: u64,
    max_retries: u32,
    reorg_period: u64,
    db: AbacusDB,
    inbox: Arc<CachingInbox>,
    prover_sync: MerkleTreeBuilder,
    retry_queue: BinaryHeap<MessageToRetry>,
    processor_loop_gauge: IntGauge,
    processed_gauge: IntGauge,
    retry_queue_length_gauge: IntGauge,
}

#[derive(PartialEq, Eq, PartialOrd, Ord)]
struct MessageToRetry {
    time_to_retry: Reverse<Instant>,
    leaf_index: u32,
    retries: u32,
}

#[derive(Debug)]
enum MessageProcessingStatus {
    NotDestinedForInbox,
    NotYetCheckpointed,
    Processed,
    Error,
}

impl MessageProcessor {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        outbox: Outboxes,
        polling_interval: u64,
        max_retries: u32,
        db: AbacusDB,
        reorg_period: u64,
        inbox: Arc<CachingInbox>,
        leaf_index_gauge: IntGaugeVec,
        retry_queue_length: IntGaugeVec,
    ) -> Self {
        let processor_loop_gauge = leaf_index_gauge.with_label_values(&[
            "processor_loop",
            outbox.chain_name(),
            inbox.chain_name(),
        ]);
        let processed_gauge = leaf_index_gauge.with_label_values(&[
            "message_processed",
            outbox.chain_name(),
            inbox.chain_name(),
        ]);
        let retry_queue_length_gauge =
            retry_queue_length.with_label_values(&[outbox.chain_name(), inbox.chain_name()]);
        Self {
            polling_interval,
            max_retries,
            reorg_period,
            prover_sync: MerkleTreeBuilder::new(db.clone()),
            db,
            inbox,
            retry_queue: BinaryHeap::new(),
            processor_loop_gauge,
            processed_gauge,
            retry_queue_length_gauge,
        }
    }

    #[instrument(ret, err, skip(self), fields(inbox_name=self.inbox.chain_name()), level = "debug")]
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
                            let latest_cached_checkpoint = self
                                .inbox
                                .latest_cached_checkpoint(Some(self.reorg_period))
                                .await?;

                            self.prover_sync
                                .update_to_checkpoint(&latest_cached_checkpoint)
                                .await?;

                            if message_leaf_index >= self.prover_sync.count() {
                                return Ok(MessageProcessingStatus::NotYetCheckpointed);
                            }
                        }

                        match self.prover_sync.get_proof(message_leaf_index) {
                            Ok(proof) => match self.inbox.process(&message.message, &proof).await {
                                Ok(outcome) => {
                                    info!(
                                        leaf_index = message_leaf_index,
                                        hash = ?outcome.txid,
                                        "[MessageProcessor] processed"
                                    );
                                    self.db.mark_leaf_as_processed(message_leaf_index)?;
                                    Ok(MessageProcessingStatus::Processed)
                                }
                                Err(err) => {
                                    error!(leaf_index = message_leaf_index, error=?err, "MessageProcessor failed processing, enqueue for retry");
                                    Ok(MessageProcessingStatus::Error)
                                }
                            },
                            Err(err) => {
                                error!(error=?err, "MessageProcessor was unable to fetch proof");
                                bail!("MessageProcessor was unable to fetch proof");
                            }
                        }
                    }
                    MessageStatus::Processed => {
                        debug!(
                            leaf_index = message_leaf_index,
                            domain = self.inbox.local_domain(),
                            "Already processed"
                        );
                        self.db.mark_leaf_as_processed(message_leaf_index)?;
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

    #[instrument(ret, err, skip(self), fields(inbox_name=self.inbox.chain_name()), level = "info")]
    async fn main_loop(mut self) -> Result<()> {
        let mut message_leaf_index = 0;
        loop {
            self.processor_loop_gauge.set(message_leaf_index as i64);
            self.retry_queue_length_gauge
                .set(self.retry_queue.len() as i64);
            if self
                .db
                .retrieve_leaf_processing_status(message_leaf_index)?
                .is_some()
            {
                message_leaf_index += 1;
                continue;
            }
            // Sleep to not fire too many view calls in a short duration
            sleep(Duration::from_millis(20)).await;

            match self.db.leaf_by_leaf_index(message_leaf_index)? {
                Some(_) => {
                    // We have unseen messages to process
                    info!(
                        destination = self.inbox.local_domain(),
                        leaf_index = message_leaf_index,
                        "Process fresh leaf"
                    );
                    match self.try_processing_message(message_leaf_index).await? {
                        MessageProcessingStatus::Processed => {
                            self.processed_gauge.set(message_leaf_index as i64);
                            message_leaf_index += 1
                        }
                        MessageProcessingStatus::NotYetCheckpointed => {
                            // If we don't have an up to date checkpoint, sleep and try again
                            sleep(Duration::from_secs(self.polling_interval)).await;
                        }
                        MessageProcessingStatus::NotDestinedForInbox => message_leaf_index += 1,
                        MessageProcessingStatus::Error => {
                            warn!(
                                destination = self.inbox.local_domain(),
                                leaf_index = message_leaf_index,
                                "Message could not be processed, queue for retry"
                            );
                            self.retry_queue.push(MessageToRetry {
                                leaf_index: message_leaf_index,
                                time_to_retry: Reverse(Instant::now()),
                                retries: 0,
                            });
                            message_leaf_index += 1;
                        }
                    }
                }
                None => {
                    // See if we have messages to retry
                    if let Some(MessageToRetry { time_to_retry, .. }) = self.retry_queue.peek() {
                        // Since we use Reverse, we want time_to_retry to be smaller
                        if time_to_retry < &Reverse(Instant::now()) {
                            continue;
                        }
                    }
                    match self.retry_queue.pop() {
                        Some(MessageToRetry {
                            leaf_index,
                            retries,
                            ..
                        }) => {
                            info!(
                                destination = self.inbox.local_domain(),
                                leaf_index = leaf_index,
                                retries = retries,
                                retry_queue_length = self.retry_queue.len(),
                                "Retry processing of message"
                            );
                            match self.try_processing_message(leaf_index).await? {
                                MessageProcessingStatus::NotDestinedForInbox
                                | MessageProcessingStatus::NotYetCheckpointed => {
                                    error!(
                                        leaf_index = leaf_index,
                                        "Somehow we tried to retry a message that cant be retried"
                                    );
                                    bail!(
                                        "Somehow we tried to retry a message that cant be retried"
                                    )
                                }
                                MessageProcessingStatus::Processed => {}
                                MessageProcessingStatus::Error => {
                                    warn!(
                                        destination = self.inbox.local_domain(),
                                        leaf_index = leaf_index,
                                        retries = retries,
                                        retry_queue_length = self.retry_queue.len(),
                                        "Retry of message failed processing"
                                    );
                                    if retries >= self.max_retries {
                                        error!(
                                        destination = self.inbox.local_domain(),
                                        leaf_index = leaf_index,
                                        retries = retries,
                                        retry_queue_length = self.retry_queue.len(),
                                        "Maximum number of retries exceeded for processing message"
                                    );
                                        continue;
                                    }
                                    let retries = retries + 1;
                                    let time_to_retry = Reverse(
                                        Instant::now()
                                            + Duration::from_secs(2u64.pow(retries as u32)),
                                    );
                                    self.retry_queue.push(MessageToRetry {
                                        leaf_index,
                                        time_to_retry,
                                        retries,
                                    });
                                }
                            }
                        }
                        None => {
                            // Nothing to do, just sleep
                            sleep(Duration::from_secs(1)).await;
                        }
                    }
                }
            }
        }
    }

    pub(crate) fn spawn(self) -> Instrumented<JoinHandle<Result<()>>> {
        let span = info_span!("MessageProcessor");
        tokio::spawn(async move { self.main_loop().await }).instrument(span)
    }
}
