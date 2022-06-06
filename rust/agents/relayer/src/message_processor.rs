use std::{
    cmp::Reverse,
    collections::BinaryHeap,
    time::{Duration, Instant},
};

use abacus_base::{InboxContracts, Outboxes};
use abacus_core::{
    db::AbacusDB, AbacusCommon, AbacusContract, CommittedMessage, Inbox, InboxValidatorManager,
    MessageStatus, MultisigSignedCheckpoint,
};
use eyre::{bail, Result};
use prometheus::{IntGauge, IntGaugeVec};
use tokio::{
    sync::mpsc::{error::TryRecvError, Receiver},
    task::JoinHandle,
    time::sleep,
};
use tracing::{
    debug, error, info, info_span, instrument, instrument::Instrumented, warn, Instrument,
};

use crate::merkle_tree_builder::MerkleTreeBuilder;

pub(crate) struct MessageProcessor {
    polling_interval: u64,
    max_retries: u32,
    #[allow(dead_code)] // TODO come back to this
    reorg_period: u64,
    db: AbacusDB,
    inbox_contracts: InboxContracts,
    prover_sync: MerkleTreeBuilder,
    retry_queue: BinaryHeap<MessageToRetry>,
    signed_checkpoint_receiver: Receiver<MultisigSignedCheckpoint>,
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
        inbox_contracts: InboxContracts,
        signed_checkpoint_receiver: Receiver<MultisigSignedCheckpoint>,
        leaf_index_gauge: IntGaugeVec,
        retry_queue_length: IntGaugeVec,
    ) -> Self {
        let processor_loop_gauge = leaf_index_gauge.with_label_values(&[
            "processor_loop",
            outbox.chain_name(),
            inbox_contracts.inbox.chain_name(),
        ]);
        let processed_gauge = leaf_index_gauge.with_label_values(&[
            "message_processed",
            outbox.chain_name(),
            inbox_contracts.inbox.chain_name(),
        ]);
        let retry_queue_length_gauge = retry_queue_length
            .with_label_values(&[outbox.chain_name(), inbox_contracts.inbox.chain_name()]);
        Self {
            polling_interval,
            max_retries,
            reorg_period,
            prover_sync: MerkleTreeBuilder::new(db.clone()),
            db,
            inbox_contracts,
            retry_queue: BinaryHeap::new(),
            signed_checkpoint_receiver,
            processor_loop_gauge,
            processed_gauge,
            retry_queue_length_gauge,
        }
    }

    #[instrument(ret, err, skip(self), fields(inbox_name=self.inbox_contracts.inbox.chain_name()), level = "debug")]
    async fn try_processing_message(
        &mut self,
        latest_signed_checkpoint: &MultisigSignedCheckpoint,
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
                if message.message.destination != self.inbox_contracts.inbox.local_domain() {
                    return Ok(MessageProcessingStatus::NotDestinedForInbox);
                }

                match self.inbox_contracts.inbox.message_status(leaf).await? {
                    MessageStatus::None => {
                        if message_leaf_index >= self.prover_sync.count() {
                            // gotta find a root that includes the message
                            // TODO come back here
                            // let latest_cached_checkpoint = self
                            //     .inbox
                            //     .latest_cached_checkpoint(Some(self.reorg_period))
                            //     .await?;

                            // let latest_signed_checkpoint = self.signed_checkpoint_receiver.recv().await.ok_or(eyre::eyre!("TODO come back"))?;

                            // let latest_cached_checkpoint = Checkpoint {
                            //     outbox_domain: 1,
                            //     root: H256::zero(),
                            //     index: 1,
                            // };

                            self.prover_sync
                                .update_to_checkpoint(&latest_signed_checkpoint.checkpoint)
                                .await?;

                            if message_leaf_index >= self.prover_sync.count() {
                                return Ok(MessageProcessingStatus::NotYetCheckpointed);
                            }
                        }

                        match self.prover_sync.get_proof(message_leaf_index) {
                            Ok(proof) => match self
                                .inbox_contracts
                                .validator_manager
                                .process(latest_signed_checkpoint, &message.message, &proof)
                                .await
                            {
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
                            domain = self.inbox_contracts.inbox.local_domain(),
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

    /// Read any signed checkpoints that the channel may have received,
    /// setting the one with the latest index to latest_signed_checkpoint.
    /// Non-blocking. Intended to handle situations where signed checkpoints
    /// are sent faster than they are received.
    fn get_latest_signed_checkpoint(
        &mut self,
        mut latest_signed_checkpoint: MultisigSignedCheckpoint,
    ) -> Result<MultisigSignedCheckpoint> {
        loop {
            match self.signed_checkpoint_receiver.try_recv() {
                Ok(signed_checkpoint) => {
                    if signed_checkpoint.checkpoint.index
                        > latest_signed_checkpoint.checkpoint.index
                    {
                        latest_signed_checkpoint = signed_checkpoint;
                    }
                }
                Err(TryRecvError::Empty) => {
                    return Ok(latest_signed_checkpoint);
                }
                Err(TryRecvError::Disconnected) => {
                    // Occurs if the channel is currently empty and there are no outstanding senders or permits
                    eyre::bail!("Booo disconnected!");
                }
            }
        }
    }

    #[instrument(ret, err, skip(self), fields(inbox_name=self.inbox_contracts.inbox.chain_name()), level = "info")]
    async fn main_loop(mut self) -> Result<()> {
        let mut message_leaf_index = 0;
        // Block until the first signed checkpoint is received
        let mut latest_signed_checkpoint = self
            .signed_checkpoint_receiver
            .recv()
            .await
            .ok_or(eyre::eyre!("TODO come back"))?;

        loop {
            // Get latest signed checkpoint, non-blocking
            latest_signed_checkpoint =
                self.get_latest_signed_checkpoint(latest_signed_checkpoint)?;

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
                        destination = self.inbox_contracts.inbox.local_domain(),
                        leaf_index = message_leaf_index,
                        "Process fresh leaf"
                    );
                    match self
                        .try_processing_message(&latest_signed_checkpoint, message_leaf_index)
                        .await?
                    {
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
                                destination = self.inbox_contracts.inbox.local_domain(),
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
                                destination = self.inbox_contracts.inbox.local_domain(),
                                leaf_index = leaf_index,
                                retries = retries,
                                retry_queue_length = self.retry_queue.len(),
                                "Retry processing of message"
                            );
                            match self
                                .try_processing_message(&latest_signed_checkpoint, leaf_index)
                                .await?
                            {
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
                                        destination = self.inbox_contracts.inbox.local_domain(),
                                        leaf_index = leaf_index,
                                        retries = retries,
                                        retry_queue_length = self.retry_queue.len(),
                                        "Retry of message failed processing"
                                    );
                                    if retries >= self.max_retries {
                                        error!(
                                        destination = self.inbox_contracts.inbox.local_domain(),
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
