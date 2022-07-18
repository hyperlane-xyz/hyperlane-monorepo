use std::collections::BinaryHeap;
use std::sync::Arc;

use abacus_base::CoreMetrics;
use abacus_base::InboxValidatorManagers;
use abacus_core::InboxValidatorManager;
use abacus_core::MessageStatus;
use eyre::{bail, Result};
use prometheus::{Histogram, IntCounter, IntGauge};
use tokio::sync::mpsc;
use tokio::sync::mpsc::error::TryRecvError;
use tokio::task::JoinHandle;
use tokio::time::Instant;
use tracing::debug;
use tracing::instrument;
use tracing::{info, info_span, instrument::Instrumented, Instrument};

use super::status::ProcessedStatusOracle;
use super::SubmitMessageArgs;

/// SerialSubmitter accepts undelivered messages over a channel from a MessageProcessor.  It is
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
/// reason, the message instead goes directly back on to the runnable queue (though it will be
/// prioritized lower than it was prior to the failed attempt due to the increased
/// num_retries).
///
/// To summarize: each scheduler `tick()`, new messages from the processor are inserted onto
/// the wait queue.  We then scan the wait_queue, looking for messages which can be promoted to
/// the runnable_queue, e.g. by comparing with a recent checkpoint or latest gas payments on
/// source chain. If eligible for delivery, the message is promoted to the runnable queue and
/// prioritized accordingly. Note that for messages that have never been attempted before, they
/// will sort very highly due to num_retries==0 and probably be tried soon.

#[derive(Debug)]
pub(crate) struct SerialSubmitter {
    /// Name of the destination chain we are submitting to.
    pub(crate) inbox_chain_name: String,
    /// Interface to acquire message status or update the status of a message.
    pub(crate) status_oracle: ProcessedStatusOracle,
    /// Interface to the destination chain's InboxValidatorManager contract for purposes of
    /// message processing.
    pub(crate) ivm: Arc<InboxValidatorManagers>,
    /// Receiver end of channel for new messages to submit.
    pub(crate) message_receiver: mpsc::UnboundedReceiver<SubmitMessageArgs>,
    /// Messages we are aware of that we want to eventually submit, but haven't yet, for
    /// whatever reason. They are not in any priority order, so are held in a vector.
    pub(crate) wait_queue: Vec<SubmitMessageArgs>,
    /// Messages that are in theory deliverable, but which are waiting in a queue for their turn
    /// to be dispatched. The SerialSubmitter can only dispatch one message at a time, so this
    /// queue could grow.
    pub(crate) run_queue: BinaryHeap<SubmitMessageArgs>,
    /// Metrics for serial submitter.
    pub(crate) metrics: SerialSubmitterMetrics,
}

impl SerialSubmitter {
    pub fn spawn(mut self) -> Instrumented<JoinHandle<Result<()>>> {
        tokio::spawn(async move { self.work_loop().await })
            .instrument(info_span!("serial submitter work loop"))
    }

    #[instrument(skip_all, fields(ibx=self.inbox_chain_name.as_str()))]
    async fn work_loop(&mut self) -> Result<()> {
        loop {
            self.tick().await?;
            tokio::time::sleep(tokio::time::Duration::from_millis(1000)).await;
        }
    }

    async fn tick(&mut self) -> Result<()> {
        // Pull any messages sent by processor over channel.
        loop {
            match self.message_receiver.try_recv() {
                Ok(msg) => {
                    self.wait_queue.push(msg);
                }
                Err(TryRecvError::Empty) => {
                    break;
                }
                Err(e) => {
                    bail!("Receive new messages from processor: {:?}", e);
                }
            }
        }

        // TODO(webbhorn): Scan verification queue, dropping messages that have been confirmed
        // processed by the inbox indexer observing it.  For any still-unverified messages that
        // have been in the verification queue for > threshold_time, move them back to the wait
        // queue for further processing.

        // Promote any newly-ready messages from the wait queue to the run queue.
        let wait_messages: Vec<_> = self.wait_queue.drain(..).collect();
        for msg in wait_messages {
            // TODO(webbhorn): Check against interchain gas paymaster.  If now enough payment,
            // promote to run queue.
            self.run_queue.push(msg);
        }
        self.wait_queue = Vec::new();

        self.metrics
            .wait_queue_length_gauge
            .set(self.wait_queue.len() as i64);
        self.metrics
            .run_queue_length_gauge
            .set(self.run_queue.len() as i64);

        // Pick the next message to try processing.
        let mut msg = match self.run_queue.pop() {
            Some(m) => m,
            None => return Ok(()),
        };

        // If the message has already been processed according to message_status call on
        // inbox, e.g. due to another relayer having already processed, then mark it as
        // already-processed, and move on to the next tick.
        // TODO(webbhorn): Make this robust to re-orgs on inbox.
        if self
            .status_oracle
            .message_status(&msg.committed_message)
            .await?
            == MessageStatus::Processed
        {
            info!(
                "Unexpected status for message with leaf index '{}' (already processed): '{:?}'",
                msg.leaf_index, msg
            );
            self.record_message_process_success(&msg)?;
            return Ok(());
        }

        // Go ahead and attempt processing of message to destination chain.
        debug!(msg=?msg, "Ready to process message");
        match self.process_message(&msg).await {
            Ok(()) => {
                info!(msg=?msg, "Message processed");
            }
            Err(e) => {
                info!(msg=?msg, "Message processing failed: {}", e);
                msg.num_retries += 1;
                self.run_queue.push(msg);
            }
        }

        Ok(())
    }

    // TODO(webbhorn): Move the process() call below into a function defined over SubmitMessageArgs
    // or wrapped Schedulable(SubmitMessageArgs) so that we can fake submit in test.
    // TODO(webbhorn): Instead of immediately marking as processed, move to a verification
    // queue, which will wait for finality and indexing by the inbox indexer and then mark
    // as processed (or eventually retry if no confirmation is ever seen).
    async fn process_message(&mut self, msg: &SubmitMessageArgs) -> Result<()> {
        let result = self
            .ivm
            .process(&msg.checkpoint, &msg.committed_message.message, &msg.proof)
            .await?;
        self.record_message_process_success(msg)?;
        info!(leaf_index=?msg.leaf_index, hash=?result.txid,
            wq_sz=?self.wait_queue.len(), rq_sz=?self.run_queue.len(),
            "Message successfully processed");
        Ok(())
    }

    /// Record in AbacusDB and various metrics that this process has observed the successful
    /// processing of a message. An Ok(()) value returned by this function is the 'commit' point
    /// in a message's lifetime for final processing -- after this function has been seen to
    /// return 'Ok(())', then without a wiped AbacusDB, we will never re-attempt processing for
    /// this message again, even after the relayer restarts.
    fn record_message_process_success(&mut self, msg: &SubmitMessageArgs) -> Result<()> {
        self.status_oracle.mark_processed(&msg.committed_message)?;
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
