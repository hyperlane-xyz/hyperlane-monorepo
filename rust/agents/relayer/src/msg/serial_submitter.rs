use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use derive_new::new;
use eyre::{bail, Result};
use prometheus::{IntCounter, IntGauge};
use tokio::sync::mpsc::{self, error::TryRecvError};
use tokio::task::JoinHandle;
use tokio::time::sleep;
use tracing::{debug, error, info, info_span, instrument, instrument::Instrumented, Instrument};

use crate::msg::PendingMessage;
use hyperlane_base::{CachingMailbox, CoreMetrics};
use hyperlane_core::{db::HyperlaneDB, HyperlaneChain, HyperlaneDomain, Mailbox, U256};

use super::{gas_payment::GasPaymentEnforcer, metadata_builder::MetadataBuilder};

/// SerialSubmitter accepts undelivered messages over a channel from a
/// MessageProcessor. It is responsible for executing the right strategy to
/// deliver those messages to the destination chain. It is designed to be used
/// in a scenario allowing only one simultaneously in-flight submission, a
/// consequence imposed by strictly ordered nonces at the target chain combined
/// with a hesitancy to speculatively batch > 1 messages with a sequence of
/// nonces, which entails harder to manage error recovery, could lead to head of
/// line blocking, etc.
///
/// The single transaction execution slot is (likely) a bottlenecked resource
/// under steady state traffic, so the SerialSubmitter implemented in this file
/// carefully schedules work items (pending messages) onto the constrained
/// resource (transaction execution slot) according to a policy that
/// incorporates both user-visible metrics (like distribution of message
/// delivery latency and delivery order), as well as message delivery
/// eligibility (e.g. due to (non-)existence of source chain gas payments).
///
/// Messages which failed delivery due to a retriable error are also retained
/// within the SerialSubmitter, and will eventually be retried according to our
/// prioritization rule.
///
/// Finally, the SerialSubmitter ensures that message delivery is robust to
/// destination chain reorgs prior to committing delivery status to
/// HyperlaneDB.
///
///
/// Objectives
/// ----------
///
/// A few primary objectives determine the structure of this scheduler:
///
/// 1. Progress for well-behaved applications should not be inhibited by
/// delivery of messages for which we have evidence of possible issues
/// (i.e., that we have already tried and failed to deliver them, and have
/// retained them for retry). So we should attempt delivery of fresh
/// messages (num_retries=0) before ones that have been failing for a
/// while (num_retries>0)
///
/// 2. Messages should be delivered in-order, i.e. if msg_a was sent on source
/// chain prior to msg_b, and they're both destined for the same destination
/// chain and are otherwise eligible, we should try to deliver msg_a before
/// msg_b, all else equal. This is because we expect applications may prefer
/// this even if they do not strictly rely on it for correctness.
///
/// 3. Be [work-conserving](https://en.wikipedia.org/wiki/Work-conserving_scheduler) w.r.t.
/// the single execution slot, i.e. so long as there is at least one message
/// eligible for submission, we should be working on it within reason. This
/// must be balanced with the cost of making RPCs that will almost certainly
/// fail and potentially block new messages from being sent immediately.
///
/// TODO: Do we also want to await finality_blocks on source chain before
///  attempting submission? Does this already happen?
#[derive(Debug, new)]
pub(crate) struct SerialSubmitter {
    /// Receiver for new messages to submit.
    rx: mpsc::UnboundedReceiver<PendingMessage>,
    /// Messages waiting for their turn to be dispatched. The SerialSubmitter
    /// can only dispatch one message at a time, so this queue could grow.
    #[new(default)]
    run_queue: BinaryHeap<Reverse<PendingMessage>>,
    /// Mailbox on the destination chain.
    mailbox: CachingMailbox,
    /// Used to construct the ISM metadata needed to verify a message.
    metadata_builder: MetadataBuilder,
    /// Interface to agent rocks DB for e.g. writing delivery status upon
    /// completion.
    db: HyperlaneDB,
    /// Metrics for serial submitter.
    metrics: SerialSubmitterMetrics,
    /// Used to determine if messages have made sufficient gas payments.
    gas_payment_enforcer: Arc<GasPaymentEnforcer>,
    /// Hard limit on transaction gas when submitting a transaction.
    transaction_gas_limit: Option<U256>,
}

impl SerialSubmitter {
    pub fn spawn(mut self) -> Instrumented<JoinHandle<Result<()>>> {
        tokio::spawn(async move { self.work_loop().await })
            .instrument(info_span!("serial submitter work loop"))
    }

    #[instrument(skip_all, fields(mbx=%self.mailbox.domain()))]
    async fn work_loop(&mut self) -> Result<()> {
        loop {
            self.tick().await?;
            sleep(Duration::from_millis(200)).await;
        }
    }

    /// Tick represents a single round of scheduling wherein we will process
    /// each queue and await at most one message submission. It is extracted
    /// from the main loop to allow for testing the state of the scheduler
    /// at particular points without having to worry about concurrent
    /// access.
    async fn tick(&mut self) -> Result<()> {
        // Pull any messages sent by processor over channel.
        loop {
            match self.rx.try_recv() {
                Ok(msg) => {
                    self.run_queue.push(Reverse(msg));
                }
                Err(TryRecvError::Empty) => {
                    break;
                }
                Err(_) => {
                    bail!("Disconnected rcvq or fatal err");
                }
            }
        }

        // TODO: Scan verification queue, dropping messages that have been
        // confirmed processed by the mailbox indexer observing it. For any
        // still-unverified messages that have been in the verification queue
        // for > threshold_time, move them back to the wait queue for further
        // processing.

        self.metrics
            .run_queue_length_gauge
            .set(self.run_queue.len() as i64);

        // check if the next message is going to be processable
        if let Some(Reverse(PendingMessage {
            next_attempt_after: Some(retry_after),
            ..
        })) = self.run_queue.peek()
        {
            if Instant::now() < *retry_after {
                return Ok(());
            }
        }

        // Pick the next message to try processing.
        let mut msg = match self.run_queue.pop() {
            Some(m) => m.0,
            None => return Ok(()),
        };

        match self.process_message(&msg).await {
            Ok(true) => {
                info!(msg=%msg.message, "Message processed");
                self.record_message_process_success(&msg)?;
                return Ok(());
            }
            Ok(false) => {
                info!(msg=%msg.message, "Message not processed");
            }
            // We expect this branch to be hit when there is unexpected behavior -
            // defined behavior like gas estimation failing will not hit this branch.
            Err(error) => {
                error!(msg=%msg.message, ?error, "Error occurred when attempting to process message");
            }
        }

        // The message was not processed, so increment the # of retries and add
        // it back to the run_queue so it will be processed again at some point.
        msg.num_retries += 1;
        msg.last_attempted_at = Instant::now();
        msg.next_attempt_after =
            Self::calculate_msg_backoff(msg.num_retries).map(|dur| msg.last_attempted_at + dur);
        self.run_queue.push(Reverse(msg));

        Ok(())
    }

    /// Returns the message's status. If the message is processed, either by a
    /// transaction in this fn or by a view call to the Mailbox contract
    /// discovering the message has already been processed, Ok(true) is
    /// returned. If this message is unable to be processed, either due to
    /// failed gas estimation or an insufficient gas payment, Ok(false) is
    /// returned.
    #[instrument(skip(self))]
    async fn process_message(&self, msg: &PendingMessage) -> Result<bool> {
        // If the message has already been processed, e.g. due to another relayer having
        // already processed, then mark it as already-processed, and move on to
        // the next tick.
        //
        // TODO(webbhorn): Make this robust to re-orgs on mailbox.
        if self.mailbox.delivered(msg.message.id()).await? {
            debug!("Message already processed");
            return Ok(true);
        }

        let Some(metadata) = self.metadata_builder
            .fetch_metadata(&msg.message, self.mailbox.clone())
            .await?
        else {
            info!("Could not fetch metadata");
            return Ok(false)
        };

        // Estimate transaction costs for the process call. If there are issues, it's
        // likely that gas estimation has failed because the message is
        // reverting. This is defined behavior, so we just log the error and
        // move onto the next tick.
        let tx_cost_estimate = match self
            .mailbox
            .process_estimate_costs(&msg.message, &metadata)
            .await
        {
            Ok(tx_cost_estimate) => tx_cost_estimate,
            Err(error) => {
                info!(?error, "Error estimating process costs");
                return Ok(false);
            }
        };

        // If the gas payment requirement hasn't been met, move to the next tick.
        let Some(gas_limit) = self
            .gas_payment_enforcer
            .message_meets_gas_payment_requirement(&msg.message, &tx_cost_estimate)
            .await?
        else {
            info!(?tx_cost_estimate, "Gas payment requirement not met yet");
            return Ok(false);
        };

        // Go ahead and attempt processing of message to destination chain.
        debug!(?gas_limit, "Ready to process message");

        // TODO: consider differentiating types of processing errors, and pushing to the
        //  front of the run queue for intermittent types of errors that can
        //  occur even if a message's processing isn't reverting, e.g. timeouts
        //  or txs being dropped from the mempool. To avoid consistently retrying
        //  only these messages, the number of retries could be considered.

        let gas_limit = tx_cost_estimate.gas_limit;

        if let Some(max_limit) = self.transaction_gas_limit {
            if gas_limit > max_limit {
                info!("Message delivery estimated gas exceeds max gas limit");
                return Ok(false);
            }
        }

        // We use the estimated gas limit from the prior call to
        // `process_estimate_costs` to avoid a second gas estimation.
        let outcome = self
            .mailbox
            .process(&msg.message, &metadata, Some(gas_limit))
            .await?;

        // TODO(trevor): Instead of immediately marking as processed, move to a
        //  verification queue, which will wait for finality and indexing by the
        //  mailbox indexer and then mark as processed (or eventually retry if
        //  no confirmation is ever seen).

        self.gas_payment_enforcer
            .record_tx_outcome(&msg.message, outcome)?;
        if outcome.executed {
            info!(
                hash=?outcome.txid,
                rq_sz=?self.run_queue.len(),
                "Message successfully processed by transaction"
            );
            Ok(true)
        } else {
            info!(
                hash=?outcome.txid,
                "Transaction attempting to process transaction reverted"
            );
            Ok(false)
        }
    }

    /// Record in HyperlaneDB and various metrics that this process has observed
    /// the successful processing of a message. An `Ok(())` value returned by
    /// this function is the 'commit' point in a message's lifetime for
    /// final processing -- after this function has been seen to
    /// `return Ok(())`, then without a wiped HyperlaneDB, we will never
    /// re-attempt processing for this message again, even after the relayer
    /// restarts.
    fn record_message_process_success(&mut self, msg: &PendingMessage) -> Result<()> {
        self.db.mark_nonce_as_processed(msg.message.nonce)?;
        self.metrics.max_submitted_nonce =
            std::cmp::max(self.metrics.max_submitted_nonce, msg.message.nonce);
        self.metrics
            .processed_gauge
            .set(self.metrics.max_submitted_nonce as i64);
        self.metrics.messages_processed_count.inc();
        Ok(())
    }

    /// Get duration we should wait before re-attempting to deliver a message
    /// given the number of retries.
    fn calculate_msg_backoff(num_retries: u32) -> Option<Duration> {
        if num_retries >= 16 {
            Some(Duration::from_secs(match num_retries {
                i if i < 16 => unreachable!(),
                // wait 5 min
                i if (16..24).contains(&i) => 60 * 5,
                // exponential increase + 30 min; -21 makes it so that at i = 32 it will be
                // ~60min timeout (64min to be more precise).
                i => (2u64).pow(i - 21) + 60 * 30,
            }))
        } else {
            None
        }
    }
}

#[derive(Debug)]
pub(crate) struct SerialSubmitterMetrics {
    run_queue_length_gauge: IntGauge,
    processed_gauge: IntGauge,
    messages_processed_count: IntCounter,

    /// Private state used to update actual metrics each tick.
    max_submitted_nonce: u32,
}

impl SerialSubmitterMetrics {
    pub fn new(
        metrics: &CoreMetrics,
        origin: &HyperlaneDomain,
        destination: &HyperlaneDomain,
    ) -> Self {
        let origin = origin.name();
        let destination = destination.name();
        Self {
            run_queue_length_gauge: metrics.submitter_queue_length().with_label_values(&[
                origin,
                destination,
                "run_queue",
            ]),
            messages_processed_count: metrics
                .messages_processed_count()
                .with_label_values(&[origin, destination]),
            processed_gauge: metrics.last_known_message_nonce().with_label_values(&[
                "message_processed",
                origin,
                destination,
            ]),
            max_submitted_nonce: 0,
        }
    }
}
