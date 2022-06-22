use std::sync::Arc;
use std::{
    cmp::Reverse,
    collections::BinaryHeap,
    time::{Duration, Instant},
};

use eyre::{bail, Result};
use prometheus::IntGauge;
use tokio::{
    sync::{mpsc, watch},
    task::JoinHandle,
    time::sleep,
};
use tracing::{
    debug, error, info, info_span, instrument, instrument::Instrumented, warn, Instrument,
};

use abacus_base::{CoreMetrics, InboxContracts, Outboxes};
use abacus_core::{
    db::AbacusDB, AbacusCommon, AbacusContract, ChainCommunicationError, CommittedMessage, Inbox,
    InboxValidatorManager, MessageStatus, MultisigSignedCheckpoint, Outbox, OutboxState,
};
use loop_control::LoopControl::{Continue, Flow};
use loop_control::{loop_ctrl, LoopControl};

use crate::merkle_tree_builder::MerkleTreeBuilder;
use crate::relayer::{MessageSubmitter, SubmitMessageOp};
use crate::settings::whitelist::Whitelist;

#[derive(Debug)]
pub(crate) struct MessageProcessor {
    outbox: Outboxes,
    max_retries: u32,
    db: AbacusDB,
    inbox_contracts: InboxContracts,
    prover_sync: MerkleTreeBuilder,
    retry_queue: BinaryHeap<MessageToRetry>,
    signed_checkpoint_receiver: watch::Receiver<Option<MultisigSignedCheckpoint>>,
    whitelist: Arc<Whitelist>,
    metrics: MessageProcessorMetrics,
    tx_msg: mpsc::Sender<SubmitMessageOp>,
}

#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
struct MessageToRetry {
    time_to_retry: Reverse<Instant>,
    leaf_index: u32,
    retries: u32,
}

#[derive(Debug)]
enum MessageProcessingStatus {
    NotDestinedForInbox,
    NotWhitelisted,
    NotYetCheckpointed,
    Processed,
    Error,
}

impl MessageProcessor {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        outbox: Outboxes,
        max_retries: u32,
        db: AbacusDB,
        inbox_contracts: InboxContracts,
        signed_checkpoint_receiver: watch::Receiver<Option<MultisigSignedCheckpoint>>,
        whitelist: Arc<Whitelist>,
        metrics: MessageProcessorMetrics,
        tx_msg: mpsc::Sender<SubmitMessageOp>,
    ) -> Self {
        Self {
            outbox,
            max_retries,
            prover_sync: MerkleTreeBuilder::new(db.clone()),
            db,
            inbox_contracts,
            retry_queue: BinaryHeap::new(),
            whitelist,
            signed_checkpoint_receiver,
            metrics,
            tx_msg,
        }
    }

    #[instrument(ret, err, skip(self), fields(inbox_name=self.inbox_contracts.inbox.chain_name()), level = "debug")]
    async fn try_processing_message(
        &mut self,
        latest_signed_checkpoint: &MultisigSignedCheckpoint,
        message_leaf_index: u32,
    ) -> Result<MessageProcessingStatus> {
        let message = if let Some(m) = self
            .db
            .message_by_leaf_index(message_leaf_index)?
            .map(CommittedMessage::try_from)
            .transpose()?
        {
            m
        } else {
            // Should not get here
            bail!("Somehow MessageProcessor get the leaf despite waiting for it");
        };

        let leaf = message.to_leaf();
        if message.message.destination != self.inbox_contracts.inbox.local_domain() {
            return Ok(MessageProcessingStatus::NotDestinedForInbox);
        }

        match self.inbox_contracts.inbox.message_status(leaf).await? {
            MessageStatus::None => {
                if latest_signed_checkpoint.checkpoint.index >= self.prover_sync.count() {
                    self.prover_sync
                        .update_to_checkpoint(&latest_signed_checkpoint.checkpoint)
                        .await?;
                }

                // prover_sync should always be in sync with latest_signed_checkpoint
                assert_eq!(
                    latest_signed_checkpoint.checkpoint.index + 1,
                    self.prover_sync.count()
                );

                if message_leaf_index > latest_signed_checkpoint.checkpoint.index {
                    return Ok(MessageProcessingStatus::NotYetCheckpointed);
                }
                if !self.whitelist.msg_matches(&message.message) {
                    return Ok(MessageProcessingStatus::NotWhitelisted);
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
                                "Message successfully processed"
                            );
                            self.db.mark_leaf_as_processed(message_leaf_index)?;
                            Ok(MessageProcessingStatus::Processed)
                        }
                        Err(err) => {
                            info!(leaf_index = message_leaf_index, error=?err, "Message failed to process, enqueuing for retry");
                            Ok(MessageProcessingStatus::Error)
                        }
                    },
                    Err(err) => {
                        error!(error=?err, "Unable to fetch proof");
                        bail!("Unable to fetch proof");
                    }
                }
            }
            MessageStatus::Processed => {
                debug!(
                    leaf_index = message_leaf_index,
                    domain = self.inbox_contracts.inbox.local_domain(),
                    "Message already processed"
                );
                self.db.mark_leaf_as_processed(message_leaf_index)?;
                Ok(MessageProcessingStatus::Processed)
            }
        }
    }

    /// Read a signed checkpoint that the channel may have received without blocking.
    /// Of current_latest_signed_checkpoint and the signed checkpoint received,
    /// the one with the latest index is returned.
    fn get_updated_latest_signed_checkpoint(
        &mut self,
        current_latest_signed_checkpoint: MultisigSignedCheckpoint,
    ) -> Result<MultisigSignedCheckpoint> {
        if let Some(new_signed_checkpoint) = self.get_signed_checkpoint_nonblocking()? {
            if new_signed_checkpoint.checkpoint.index
                > current_latest_signed_checkpoint.checkpoint.index
            {
                return Ok(new_signed_checkpoint);
            }
        }
        Ok(current_latest_signed_checkpoint)
    }

    /// Blocks for a MultisigSignedCheckpoint from the channel
    async fn get_signed_checkpoint_blocking(&mut self) -> Result<MultisigSignedCheckpoint> {
        // Waits for a Some(signed_checkpoint)
        loop {
            // This blocks until an unseen value is found
            self.signed_checkpoint_receiver.changed().await?;

            // If it's not None, this is what we've been waiting for
            if let Some(signed_checkpoint) = self.signed_checkpoint_receiver.borrow().clone() {
                return Ok(signed_checkpoint);
            }
        }
    }

    /// Attempts to get a signed checkpoint from the channel without blocking.
    fn get_signed_checkpoint_nonblocking(&mut self) -> Result<Option<MultisigSignedCheckpoint>> {
        if self.signed_checkpoint_receiver.has_changed()? {
            return Ok(self.signed_checkpoint_receiver.borrow_and_update().clone());
        }
        Ok(None)
    }

    #[instrument(ret, err, skip(self), fields(inbox_name=self.inbox_contracts.inbox.chain_name()), level = "info")]
    async fn main_loop(mut self) -> Result<()> {
        let mut message_leaf_index = 0;
        // Block until the first signed checkpoint is received
        let mut latest_signed_checkpoint = self.get_signed_checkpoint_blocking().await?;

        loop {
            self.update_outbox_state_gauge();

            // Get latest signed checkpoint, non-blocking
            latest_signed_checkpoint =
                self.get_updated_latest_signed_checkpoint(latest_signed_checkpoint)?;

            self.metrics
                .processor_loop_gauge
                .set(message_leaf_index as i64);
            self.metrics
                .retry_queue_length_gauge
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

            if self.db.leaf_by_leaf_index(message_leaf_index)?.is_some() {
                self.tx_msg
                    .send(SubmitMessageOp {
                        leaf_index: message_leaf_index,
                    })
                    .await?;
                message_leaf_index = self
                    .process_fresh_leaf(&mut latest_signed_checkpoint, message_leaf_index)
                    .await?;
            } else {
                loop_ctrl!(
                    self.retry_processing_message(&mut latest_signed_checkpoint)
                        .await?
                );
            }
        }
        // will only reach this if we break
        Ok(())
    }

    /// Part of main loop.
    ///
    /// Spawn a task to update the outbox state gauge.
    fn update_outbox_state_gauge(
        &self,
    ) -> JoinHandle<Result<OutboxState, ChainCommunicationError>> {
        let outbox_state_gauge = self.metrics.outbox_state_gauge.clone();
        let outbox = self.outbox.clone();
        tokio::spawn(async move {
            let state = outbox.state().await;
            match &state {
                Ok(state) => outbox_state_gauge.set(*state as u8 as i64),
                Err(e) => warn!(error = %e, "Failed to get outbox state"),
            };
            state
        })
    }

    /// Part of main loop
    ///
    /// - `returns` the new message leaf index.
    async fn process_fresh_leaf(
        &mut self,
        latest_signed_checkpoint: &mut MultisigSignedCheckpoint,
        message_leaf_index: u32,
    ) -> Result<u32> {
        // We have unseen messages to process
        info!(
            destination = self.inbox_contracts.inbox.local_domain(),
            leaf_index = message_leaf_index,
            "Evaluating fresh leaf for processing"
        );
        let new_leaf = match self
            .try_processing_message(latest_signed_checkpoint, message_leaf_index)
            .await?
        {
            MessageProcessingStatus::Processed => {
                self.metrics.processed_gauge.set(message_leaf_index as i64);
                message_leaf_index + 1
            }
            MessageProcessingStatus::NotYetCheckpointed => {
                // Do nothing. We should allow the backlog to be evaluated
                // and will eventually learn about a new signed checkpoint.
                message_leaf_index
            }
            MessageProcessingStatus::NotDestinedForInbox
            | MessageProcessingStatus::NotWhitelisted => message_leaf_index + 1,
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
                message_leaf_index + 1
            }
        };
        Ok(new_leaf)
    }

    /// Part of main loop
    async fn retry_processing_message(
        &mut self,
        latest_signed_checkpoint: &mut MultisigSignedCheckpoint,
    ) -> Result<LoopControl> {
        // See if we have messages to retry
        if let Some(MessageToRetry { time_to_retry, .. }) = self.retry_queue.peek() {
            // Since we use Reverse, we want time_to_retry to be smaller
            if time_to_retry < &Reverse(Instant::now()) {
                return Ok(Continue);
            }
        }
        let MessageToRetry {
            leaf_index,
            retries,
            ..
        } = if let Some(v) = self.retry_queue.pop() {
            v
        } else {
            // Nothing to do, just sleep
            sleep(Duration::from_secs(1)).await;
            return Ok(Flow);
        };

        info!(
            destination = self.inbox_contracts.inbox.local_domain(),
            leaf_index = leaf_index,
            retries = retries,
            retry_queue_length = self.retry_queue.len(),
            "Retry processing of message"
        );
        match self
            .try_processing_message(latest_signed_checkpoint, leaf_index)
            .await?
        {
            MessageProcessingStatus::NotDestinedForInbox
            | MessageProcessingStatus::NotYetCheckpointed
            | MessageProcessingStatus::NotWhitelisted => {
                error!(
                    leaf_index = leaf_index,
                    "Somehow we tried to retry a message that cant be retried"
                );
                bail!("Somehow we tried to retry a message that cant be retried")
            }
            MessageProcessingStatus::Processed => {}
            MessageProcessingStatus::Error => {
                info!(
                    destination = self.inbox_contracts.inbox.local_domain(),
                    leaf_index = leaf_index,
                    retries = retries,
                    retry_queue_length = self.retry_queue.len(),
                    "Retry of message failed processing"
                );
                if retries >= self.max_retries {
                    info!(
                        destination = self.inbox_contracts.inbox.local_domain(),
                        leaf_index = leaf_index,
                        retries = retries,
                        retry_queue_length = self.retry_queue.len(),
                        "Maximum number of retries exceeded for processing message"
                    );
                    return Ok(Continue);
                }
                let retries = retries + 1;
                let time_to_retry =
                    Reverse(Instant::now() + Duration::from_secs(2u64.pow(retries as u32)));
                self.retry_queue.push(MessageToRetry {
                    leaf_index,
                    time_to_retry,
                    retries,
                });
            }
        }

        Ok(Flow)
    }

    pub(crate) fn spawn(self) -> Instrumented<JoinHandle<Result<()>>> {
        let span = info_span!("MessageProcessor");
        tokio::spawn(self.main_loop()).instrument(span)
    }
}

#[derive(Debug)]
pub(crate) struct MessageProcessorMetrics {
    processor_loop_gauge: IntGauge,
    processed_gauge: IntGauge,
    retry_queue_length_gauge: IntGauge,
    outbox_state_gauge: IntGauge,
}

impl MessageProcessorMetrics {
    pub fn new(metrics: &CoreMetrics, outbox_chain: &str, inbox_chain: &str) -> Self {
        Self {
            processor_loop_gauge: metrics.last_known_message_leaf_index().with_label_values(&[
                "processor_loop",
                outbox_chain,
                inbox_chain,
            ]),
            processed_gauge: metrics.last_known_message_leaf_index().with_label_values(&[
                "message_processed",
                outbox_chain,
                inbox_chain,
            ]),
            outbox_state_gauge: metrics.outbox_state().with_label_values(&[outbox_chain]),
            retry_queue_length_gauge: metrics
                .retry_queue_length()
                .with_label_values(&[outbox_chain, inbox_chain]),
        }
    }
}
