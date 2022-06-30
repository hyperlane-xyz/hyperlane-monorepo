use std::collections::BinaryHeap;

use abacus_base::CoreMetrics;
use abacus_base::InboxContracts;
use abacus_core::db::AbacusDB;
use abacus_core::AbacusContract;
use abacus_core::InboxValidatorManager;
use eyre::{bail, Result};
use prometheus::{Histogram, IntGauge};
use tokio::sync::mpsc;
use tokio::sync::mpsc::error::TryRecvError;
use tokio::task::JoinHandle;
use tokio::time::Instant;
use tracing::instrument;
use tracing::{info, info_span, instrument::Instrumented, Instrument};

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

// TODO(webbhorn): Metrics data.
// TODO(webbhorn): Do we also want to await finality_blocks on source chain before attempting
// submission? Does this already happen?

#[allow(dead_code)]
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
    run_queue: BinaryHeap<SubmitMessageArgs>,
    /// Inbox / InboxValidatorManager on the destination chain.
    inbox_contracts: InboxContracts,
    // Interface to agent rocks DB for e.g. writing delivery status upon completion.
    db: AbacusDB,
    // Metrics for serial submitter.
    metrics: SerialSubmitterMetrics,
}

impl SerialSubmitter {
    pub(crate) fn new(
        rx: mpsc::UnboundedReceiver<SubmitMessageArgs>,
        inbox_contracts: InboxContracts,
        db: AbacusDB,
        metrics: SerialSubmitterMetrics,
    ) -> Self {
        Self {
            rx,
            wait_queue: Vec::new(),
            run_queue: BinaryHeap::new(),
            inbox_contracts,
            db,
            metrics,
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
            tokio::time::sleep(tokio::time::Duration::from_millis(1000)).await;
        }
    }

    /// Tick represents a single round of scheduling wherein we will process each queue and
    /// await at most one message submission.  It is extracted from the main loop to allow for
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
                    bail!("disconnected rcvq or fatal err");
                }
            }
        }

        // TODO(webbhorn): Scan verification queue, dropping messages that have been confirmed
        // delivered by the inbox indexer observing it.  For any still-unverified messages that
        // have been in the verification queue for > threshold_time, move them back to the wait
        // queue for further processing.

        // Promote any newly-ready messages from the wait queue to the run queue.
        for msg in &self.wait_queue {
            // TODO(webbhorn): Check if already delivered to inbox, e.g. by another relayer. In
            // that case, drop from wait queue.
            // TODO(webbhorn): Check against interchain gas paymaster.  If now enough payment,
            // promote to run queue.
            info!(msg.leaf_index, "-> runq");
            self.run_queue.push(msg.clone());
        }
        self.wait_queue = Vec::new();

        self.metrics
            .wait_queue_length_gauge
            .set(self.wait_queue.len() as i64);
        self.metrics
            .run_queue_length_gauge
            .set(self.run_queue.len() as i64);

        // Deliver the highest-priority message on the run queue.
        if let Some(mut msg) = self.run_queue.pop() {
            info!(msg=?msg, "ready to deliver message");
            match self.deliver_message(&msg).await {
                Ok(()) => {
                    info!(msg=?msg, "message delivered");
                }
                Err(e) => {
                    info!(msg=?msg, "message delivery failed: {}", e);
                    msg.num_retries += 1;
                    self.run_queue.push(msg);
                }
            }
        }
        Ok(())
    }

    // TODO(webbhorn): Move the process() call below into a function defined over SubmitMessageArgs
    // or wrapped Schedulable(SubmitMessageArgs) so that we can fake submit in test.
    async fn deliver_message(&mut self, msg: &SubmitMessageArgs) -> Result<()> {
        let result = self
            .inbox_contracts
            .validator_manager
            .process(&msg.checkpoint, &msg.committed_message.message, &msg.proof)
            .await?;
        info!(leaf_index=?msg.leaf_index, hash=?result.txid,
            wq_sz=?self.wait_queue.len(), rq_sz=?self.run_queue.len(),
            "message successfully processed");

        // TODO(webbhorn): Instead of immediately marking as processed, move to a verification
        // queue, which will wait for finality and indexing by the inbox indexer and then mark
        // as processed (or eventually retry if no confirmation is ever seen).
        self.db.mark_leaf_as_processed(msg.leaf_index)?;
        self.metrics
            .queue_duration_hist
            .observe((Instant::now() - msg.enqueue_time).as_secs_f64());
        Ok(())
    }
}

#[derive(Debug)]
pub(crate) struct SerialSubmitterMetrics {
    run_queue_length_gauge: IntGauge,
    wait_queue_length_gauge: IntGauge,
    queue_duration_hist: Histogram,
}

impl SerialSubmitterMetrics {
    pub fn new(metrics: &CoreMetrics, outbox_chain: &str, inbox_chain: &str) -> Self {
        let queue_len = metrics
            .new_int_gauge(
                "serial_submitter_queue_length",
                concat!(
                    "Size of queues within the serial message submitter parameterized by ",
                    "destination inbox and queue name"
                ),
                &["outbox_chain", "inbox_chain", "queue_name"],
            )
            .unwrap();
        Self {
            run_queue_length_gauge: queue_len.with_label_values(&[outbox_chain, inbox_chain, "run_queue"]),
            wait_queue_length_gauge: queue_len.with_label_values(&[outbox_chain, inbox_chain, "wait_queue"]),
            queue_duration_hist: metrics.new_histogram(
                "serial_submitter_seconds_in_queue",
                "Time a message spends queued in the serial submitter measured from insertion into channel from processor, ending after successful delivery to provider.",
                &["outbox_chain", "inbox_chain"], prometheus::exponential_buckets(0.5, 2., 19).unwrap())
            .unwrap().with_label_values(&[outbox_chain, inbox_chain]),
        }
    }
}
