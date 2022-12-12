use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{Duration, Instant};

use eyre::{bail, Result};
use prometheus::{Histogram, IntCounter, IntGauge};
use tokio::sync::mpsc::{self, error::TryRecvError};
use tokio::task::JoinHandle;
use tokio::time::sleep;
use tracing::{debug, info, info_span, instrument, instrument::Instrumented, warn, Instrument};

use abacus_base::{CoreMetrics, InboxContracts};
use abacus_core::{db::AbacusDB, Inbox, InboxValidatorManager, MessageStatus};

use super::{gas_payment::GasPaymentEnforcer, SubmitMessageArgs};

/// SerialSubmitter accepts undelivered messages over a channel from a MessageProcessor. It is
/// responsible for executing the right strategy to deliver those messages to the destination
/// chain. It is designed to be used in a scenario allowing only one simultaneously in-flight
/// submission, a consequence imposed by strictly ordered nonces at the target chain combined
/// with a hesitancy to speculatively batch > 1 messages with a sequence of nonces, which
/// entails harder to manage error recovery, could lead to head of line blocking, etc.
///
/// The single transaction execution slot is (likely) a bottlenecked resource under steady
/// state traffic, so the SerialSubmitter implemented in this file carefully schedules work
/// items (pending messages) onto the constrained resource (transaction execution slot)
/// according to a policy that incorporates both user-visible metrics (like distribution of
/// message delivery latency and delivery order), as well as message delivery eligibility (e.g.
/// due to (non-)existence of source chain gas payments).
///
/// Messages which failed delivery due to a retriable error are also retained within the
/// SerialSubmitter, and will eventually be retried according to our prioritization rule.
///
/// Finally, the SerialSubmitter ensures that message delivery is robust to destination chain
/// re-orgs prior to committing delivery status to AbacusDB.
///
///
/// Objectives
/// ----------
///
/// A few primary objectives determine the structure of this scheduler:
///
/// 1.  Progress for well-behaved applications should not be inhibited by delivery of messages
///     for which we have evidence of possible issues (i.e., that we have already tried and
///     failed to deliver them, and have retained them for retry). So we should attempt
///     delivery of fresh messages (num_retries=0) before ones that have been failing for a
///     while (num_retries>0)
///
/// 2.  Messages should be delivered in-order, i.e. if msg_a was sent on source chain prior to
///     msg_b, and they're both destined for the same destination chain and are otherwise eligible,
///     we should try to deliver msg_a before msg_b, all else equal. This is because we expect
///     applications may prefer this even if they do not strictly rely on it for correctness.
///
/// 3.  Be [work-conserving](https://en.wikipedia.org/wiki/Work-conserving_scheduler) w.r.t.
///     the single execution slot, i.e. so long as there is at least one message eligible for
///     submission, we should be working on it, rather than e.g.:
///     *  awaiting something to appear in a channel via tokio::select!
///     *  sitting around with a massive backlog waiting for a time-based retry backoff to
///        expire. What's the point? We should work through the backlog at every opportunity,
///        or we may never clear it!
///
/// Therefore we order the priority queue of runnable messages by the key:
///     <num_retries, leaf_idx>
/// picking the lexicographically least element in the runnable set to execute next.
///
///
/// Implementation
/// --------------
///
/// Messages may have been received from the MessageProcessor but not yet be eligible for submission.
/// The reasons a message might not be eligible are:
///
///  *  Insufficient interchain gas payment on source chain
///  *  Already delivered to destination chain, e.g. maybe by a different relayer, or the result of
///     a submission attempt just prior to an old incarnation of this task crashing.
///  *  Not whitelisted (currently checked by processor)
///  *  Wrong destination chain (currently checked by processor)
///  *  Checkpoint index < leaf index (currently checked by processor)
///
/// Therefore, we maintain two queues of messages:
///
///   1.  run_queue: messages which are eligible for submission but waiting for
///       their turn to run, since we can only do one at a time.
///
///   2.  wait_queue: messages currently ineligible for submission, due to one of the
///       reasons listed above (e.g. index not covered by checkpoint, insufficient gas, etc).
///
/// Note that there is no retry queue. This is because if submission fails for a retriable
/// reason, the message instead goes directly back on to the runnable queue.
/// If submission fails, the message is sent to the back of the queue. This is to ensure
/// all messages are retried frequently, and not just those that happen to have a lower
/// retry count.
///
/// To summarize: each scheduler `tick()`, new messages from the processor are inserted onto
/// the wait queue. We then scan the wait_queue, looking for messages which can be promoted to
/// the runnable_queue, e.g. by comparing with a recent checkpoint or latest gas payments on
/// source chain. If eligible for delivery, the message is promoted to the runnable queue and
/// prioritized accordingly. These messages that have never been tried before are pushed to
/// the front of the runnable queue.

// TODO(webbhorn): Do we also want to await finality_blocks on source chain before attempting
// submission? Does this already happen?

#[derive(Debug)]
pub(crate) struct SerialSubmitter {
    /// Receiver for new messages to submit.
    rx: mpsc::UnboundedReceiver<SubmitMessageArgs>,
    /// Messages we are aware of that we want to eventually submit, but haven't yet, for
    /// whatever reason. They are not in any priority order, so are held in a vector.
    wait_queue: Vec<SubmitMessageArgs>,
    /// Messages that are in theory deliverable, but which are waiting in a queue for their turn
    /// to be dispatched. The SerialSubmitter can only dispatch one message at a time, so this
    /// queue could grow.
    run_queue: VecDeque<SubmitMessageArgs>,
    /// Inbox / InboxValidatorManager on the destination chain.
    inbox_contracts: InboxContracts,
    /// Interface to agent rocks DB for e.g. writing delivery status upon completion.
    db: AbacusDB,
    /// Metrics for serial submitter.
    metrics: SerialSubmitterMetrics,
    /// Used to determine if messages have made sufficient gas payments.
    gas_payment_enforcer: Arc<GasPaymentEnforcer>,
}

impl SerialSubmitter {
    pub(crate) fn new(
        rx: mpsc::UnboundedReceiver<SubmitMessageArgs>,
        inbox_contracts: InboxContracts,
        db: AbacusDB,
        metrics: SerialSubmitterMetrics,
        gas_payment_enforcer: Arc<GasPaymentEnforcer>,
    ) -> Self {
        Self {
            rx,
            wait_queue: Vec::new(),
            run_queue: VecDeque::new(),
            inbox_contracts,
            db,
            metrics,
            gas_payment_enforcer,
        }
    }

    pub fn spawn(mut self) -> Instrumented<JoinHandle<Result<()>>> {
        tokio::spawn(async move { self.work_loop().await })
            .instrument(info_span!("serial submitter work loop"))
    }

    #[instrument(skip_all, fields(ibx=self.inbox_contracts.inbox.inbox().chain_name()))]
    async fn work_loop(&mut self) -> Result<()> {
        loop {
            self.tick().await?;
            sleep(Duration::from_secs(1)).await;
        }
    }

    /// Tick represents a single round of scheduling wherein we will process each queue and
    /// await at most one message submission. It is extracted from the main loop to allow for
    /// testing the state of the scheduler at particular points without having to worry about
    /// concurrent access.
    async fn tick(&mut self) -> Result<()> {
        // Pull any messages sent by processor over channel.
        loop {
            match self.rx.try_recv() {
                Ok(msg) => {
                    self.wait_queue.push(msg);
                }
                Err(TryRecvError::Empty) => {
                    break;
                }
                Err(_) => {
                    bail!("Disconnected rcvq or fatal err");
                }
            }
        }

        // TODO(webbhorn): Scan verification queue, dropping messages that have been confirmed
        // processed by the inbox indexer observing it. For any still-unverified messages that
        // have been in the verification queue for > threshold_time, move them back to the wait
        // queue for further processing.

        // Promote any newly-ready messages from the wait queue to the run queue.
        // The order of wait_messages, which includes messages asc ordered by leaf index,
        // is preserved and pushed at the front of the run_queue to ensure that new messages
        // are evaluated first.
        for msg in self.wait_queue.drain(..).rev() {
            // TODO(webbhorn): Check against interchain gas paymaster. If now enough payment,
            // promote to run queue.
            self.run_queue.push_front(msg);
        }

        self.metrics
            .wait_queue_length_gauge
            .set(self.wait_queue.len() as i64);
        self.metrics
            .run_queue_length_gauge
            .set(self.run_queue.len() as i64);

        // Pick the next message to try processing.
        let mut msg = match self.run_queue.pop_front() {
            Some(m) => m,
            None => return Ok(()),
        };

        if msg.num_retries >= 2 {
            let required_duration = Duration::from_secs(match msg.num_retries {
                i if i < 2 => unreachable!(),
                i if (2..8).contains(&i) => 60,        // wait 1 min
                i if (8..16).contains(&i) => 60 * 5,   // wait 5 min
                i if (16..24).contains(&i) => 60 * 30, // wait 30 min
                _ => 60 * 60,                          // max timeout of 1hr beyond that
            });
            if Instant::now().duration_since(msg.last_attempted_at) < required_duration {
                self.run_queue.push_back(msg);
                return Ok(());
            }
        }

        match self.process_message(&msg).await {
            Ok(MessageStatus::Processed) => {
                info!(msg=?msg, msg_leaf_index=msg.leaf_index, "Message processed");
                self.record_message_process_success(&msg)?;
                return Ok(());
            }
            Ok(MessageStatus::None) => {
                info!(msg=?msg, msg_leaf_index=msg.leaf_index, "Message not processed");
            }
            // We expect this branch to be hit when there is unexpected behavior -
            // defined behavior like gas estimation failing will not hit this branch.
            Err(err) => {
                warn!(msg=?msg, msg_leaf_index=msg.leaf_index, error=?err, "Error occurred when attempting to process message");
            }
        }

        // The message was not processed, so increment the # of retries and add
        // it back to the run_queue so it will be processed again at some point.
        msg.num_retries += 1;
        msg.last_attempted_at = Instant::now();
        self.run_queue.push_back(msg);

        Ok(())
    }

    /// Returns the message's status. If the message is processed, either by a transaction
    /// in this fn or by a view call to the Inbox contract discovering the message has already
    /// been processed, Ok(MessageStatus::Processed) is returned. If this message is unable to
    /// be processed, either due to failed gas estimation or an insufficient gas payment,
    /// Ok(MessageStatus::None) is returned.
    #[instrument(skip(self, msg), fields(msg_leaf_index=msg.leaf_index))]
    async fn process_message(&self, msg: &SubmitMessageArgs) -> Result<MessageStatus> {
        // If the message has already been processed according to message_status call on
        // inbox, e.g. due to another relayer having already processed, then mark it as
        // already-processed, and move on to the next tick.
        // TODO(webbhorn): Make this robust to re-orgs on inbox.
        if let MessageStatus::Processed = self
            .inbox_contracts
            .inbox
            .message_status(msg.committed_message.to_leaf())
            .await?
        {
            info!("Message already processed");
            return Ok(MessageStatus::Processed);
        }

        // Estimate transaction costs for the process call. If there are issues, it's likely
        // that gas estimation has failed because the message is reverting. This is defined behavior,
        // so we just log the error and move onto the next tick.
        let tx_cost_estimate = match self
            .inbox_contracts
            .validator_manager
            .process_estimate_costs(&msg.checkpoint, &msg.committed_message.message, &msg.proof)
            .await
        {
            Ok(tx_cost_estimate) => tx_cost_estimate,
            Err(err) => {
                info!(msg=?msg, error=?err, "Error estimating process costs");
                return Ok(MessageStatus::None);
            }
        };

        // If the gas payment requirement hasn't been met, move to the next tick.
        let (meets_gas_requirement, gas_payment) = self
            .gas_payment_enforcer
            .message_meets_gas_payment_requirement(&msg.committed_message, &tx_cost_estimate)
            .await?;
        if !meets_gas_requirement {
            info!(gas_payment=?gas_payment, "Gas payment requirement not met yet");
            return Ok(MessageStatus::None);
        }

        // Go ahead and attempt processing of message to destination chain.
        debug!(gas_payment=?gas_payment, msg=?msg, "Ready to process message");

        // TODO: consider differentiating types of processing errors, and pushing to the front of the
        // run queue for intermittent types of errors that can occur even if a message's processing isn't
        // reverting, e.g. timeouts or txs being dropped from the mempool. To avoid consistently retrying
        // only these messages, the number of retries could be considered.

        // We use the estimated gas limit from the prior call to `process_estimate_costs` to
        // avoid a second gas estimation.
        let process_result = self
            .inbox_contracts
            .validator_manager
            .process(
                &msg.checkpoint,
                &msg.committed_message.message,
                &msg.proof,
                Some(tx_cost_estimate.gas_limit),
            )
            .await;
        match process_result {
            // TODO(trevor): Instead of immediately marking as processed, move to a verification
            // queue, which will wait for finality and indexing by the inbox indexer and then mark
            // as processed (or eventually retry if no confirmation is ever seen).

            // Only mark the message as processed if the transaction didn't revert.
            Ok(outcome) if outcome.executed => {
                info!(hash=?outcome.txid,
                    wq_sz=?self.wait_queue.len(), rq_sz=?self.run_queue.len(),
                    "Message successfully processed by transaction");
                Ok(MessageStatus::Processed)
            }
            Ok(outcome) => {
                info!(hash=?outcome.txid, "Transaction attempting to process transaction reverted");
                Ok(MessageStatus::None)
            }
            Err(e) => Err(e.into()),
        }
    }

    /// Record in AbacusDB and various metrics that this process has observed the successful
    /// processing of a message. An Ok(()) value returned by this function is the 'commit' point
    /// in a message's lifetime for final processing -- after this function has been seen to
    /// return 'Ok(())', then without a wiped AbacusDB, we will never re-attempt processing for
    /// this message again, even after the relayer restarts.
    fn record_message_process_success(&mut self, msg: &SubmitMessageArgs) -> Result<()> {
        self.db.mark_leaf_as_processed(msg.leaf_index)?;
        self.metrics
            .queue_duration_hist
            .observe((Instant::now() - msg.enqueue_time).as_secs_f64());
        self.metrics.max_submitted_leaf_index =
            std::cmp::max(self.metrics.max_submitted_leaf_index, msg.leaf_index);
        self.metrics
            .processed_gauge
            .set(self.metrics.max_submitted_leaf_index as i64);
        self.metrics.messages_processed_count.inc();
        Ok(())
    }
}

#[derive(Debug)]
pub(crate) struct SerialSubmitterMetrics {
    run_queue_length_gauge: IntGauge,
    wait_queue_length_gauge: IntGauge,
    queue_duration_hist: Histogram,
    processed_gauge: IntGauge,
    messages_processed_count: IntCounter,

    /// Private state used to update actual metrics each tick.
    max_submitted_leaf_index: u32,
}

impl SerialSubmitterMetrics {
    pub fn new(metrics: &CoreMetrics, outbox_chain: &str, inbox_chain: &str) -> Self {
        Self {
            run_queue_length_gauge: metrics.submitter_queue_length().with_label_values(&[
                outbox_chain,
                inbox_chain,
                "run_queue",
            ]),
            wait_queue_length_gauge: metrics.submitter_queue_length().with_label_values(&[
                outbox_chain,
                inbox_chain,
                "wait_queue",
            ]),
            queue_duration_hist: metrics
                .submitter_queue_duration_histogram()
                .with_label_values(&[outbox_chain, inbox_chain]),
            messages_processed_count: metrics
                .messages_processed_count()
                .with_label_values(&[outbox_chain, inbox_chain]),
            processed_gauge: metrics.last_known_message_leaf_index().with_label_values(&[
                "message_processed",
                outbox_chain,
                inbox_chain,
            ]),
            max_submitted_leaf_index: 0,
        }
    }
}
