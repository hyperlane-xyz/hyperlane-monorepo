use std::collections::BinaryHeap;
use std::sync::Arc;

use abacus_base::{CachingInterchainGasPaymaster, InboxContracts, Outboxes};
use abacus_core::db::AbacusDB;
use abacus_core::AbacusContract;
use abacus_core::InboxValidatorManager;
use eyre::{bail, Result};
use tokio::sync::mpsc;
use tokio::sync::mpsc::error::TryRecvError;
use tokio::task::JoinHandle;
use tracing::instrument;
use tracing::{info, info_span, instrument::Instrumented, Instrument};

use super::SubmitMessageArgs;

/// The scheduler implemented in this file is responsible for managing the submission of N
/// messages to a target chain. It is designed to be used in a scenario allowing only one
/// simultaneously in-flight submission, a consequence imposed by strictly ordered nonces at
/// the target chain combined with a hesitancy to speculatively batch > 1 messages with a
/// sequence of nonces, which entails harder to manage error recovery, could lead to head of
/// line blocking, etc.
///
/// Two primary objectives determine the structure of this scheduler:
///
/// 1.  Most important messages to send are those which we haven't yet attempted
///     (num_retries==0), and among those, prioritizing messages at the highest indexes
///     first. After that, try the num_retries==1 messages with highest index first, and so on.
///     
/// 2.  Be work-conserving, i.e. so long as there is at least one message eligible for
///     submission, we should be working on it,  rather than e.g.:
///     *  awaiting something to appear in a channel via tokio::select!
///     *  sitting around with a massive backlog waiting for a time-based retry backoff
///        to expire. What's the point? We should work through the backlog.
///
/// Messages may have been received from the Processor but not yet be eligible for submission.
/// The reasons a message might not be eligible are:
///
///  *  Not whitelisted (checked by processor)
///  *  Wrong destination chain (checked by processor)
///  *  Insufficient interchain gas payment on source chain
///  *  Checkpoint index < leaf index
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
/// Each round, new messages from the processor are inserted onto the wait queue. We then scan
/// the wait_queue, looking for messages which can be promoted to the runnable_queue, e.g. by
/// comparing with a recent checkpoint or latest gas payments on source chain. If eligible, the
/// message is promoted to the runnable queue and prioritized accordingly. Note that for messages
/// that have never been attempted before, they will sort very highly due to num_retries==0 and
/// probably be tried soon.

// TODO(webbhorn): Metrics data.
// TODO(webbhorn): Do we also want to await finality_blocks on source
// chain before attempting submission? Does this already happen?

#[allow(dead_code)]
#[derive(Debug)]
pub(crate) struct SerialSubmitter {
    // Receiver for new messages to submit.
    rx: mpsc::Receiver<SubmitMessageArgs>,
    // Messages we are aware of that we want to eventually submit,
    // but haven't yet, for whatever reason. They are not in any
    // priority order, so are held in a vector.
    wait_queue: Vec<SubmitMessageArgs>,
    // Messages that are in theory deliverable, but which are waiting in a queue for
    // their turn to be dispatched. The SerialSubmitter can only dispatch one message
    // at a time, so this queue could grow.
    run_queue: BinaryHeap<SubmitMessageArgs>,
    // Inbox / InboxValidatorManager on the destination chain.
    inbox_contracts: InboxContracts,
    // Outbox on message origin chain.
    outbox: Outboxes,
    // Contract tracking interchain gas payments for use when deciding whether
    // sufficient funds have been provided for message forwarding.
    interchain_gas_paymaster: Option<Arc<CachingInterchainGasPaymaster>>,
    // The number of times to attepmt submitting each message
    // before giving up.
    //
    // TODO(webbhorn): Is this the number of attempts we'll make before permanently
    // giving up, or until we re-insert into retry queue and try the next readiest message?
    max_retries: u32,
    // Interface to agent rocks DB for e.g. writing delivery status upon completion.
    db: AbacusDB,
}

impl SerialSubmitter {
    pub(crate) fn new(
        rx: mpsc::Receiver<SubmitMessageArgs>,
        inbox_contracts: InboxContracts,
        outbox: Outboxes,
        interchain_gas_paymaster: Option<Arc<CachingInterchainGasPaymaster>>,
        max_retries: u32,
        db: AbacusDB,
    ) -> Self {
        Self {
            rx,
            wait_queue: Vec::new(),
            run_queue: BinaryHeap::new(),
            inbox_contracts,
            outbox,
            interchain_gas_paymaster,
            max_retries,
            db,
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
            //tokio::task::yield_now().await;
        }
    }

    // Tick represents a single round of scheduling wherein we will
    // process each queue and await at most one message submission.
    // It is extracted from the main loop to allow for testing the
    // state of the scheduler at particular points without having to
    // worry about concurrent access.
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
                _ => {
                    bail!("disconnected rcvq or fatal err");
                }
            }
        }

        // TODO(webbhorn): Scan verification queue, dropping messages that
        // have been confirmed delivered by the inbox indexer observing it.
        // For any still-unverified messages that have been in the verification
        // queue for > threshold_time, move them back to the wait queue for
        // further processing.

        // Promote any newly-ready messages from the wait queue to the run queue.
        for msg in &self.wait_queue {
            // TODO(webbhorn): Check if already delivered to inbox, e.g. by another
            // relay. In that case, drop from wait queue.
            // TODO(webbhorn): Check against interchain gas paymaster.  If now enough
            // payment, promote to run queue.
            info!(msg.leaf_index, "-> runq");
            self.run_queue.push(msg.clone());
        }
        self.wait_queue = Vec::new();

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

    async fn deliver_message(&mut self, msg: &SubmitMessageArgs) -> Result<()> {
        let result = self
            .inbox_contracts
            .validator_manager
            .process(&msg.checkpoint, &msg.committed_message.message, &msg.proof)
            .await?;
        info!(leaf_index=?msg.leaf_index, hash=?result.txid,
            wq_sz=?self.wait_queue.len(), rq_sz=?self.run_queue.len(),
            "message successfully processed");

        // TODO(webbhorn): Instead of immediately marking as processed,
        // move to a verification queue, which will wait for finality and
        // indexing by the inbox indexer and then mark as processed (or
        // eventually retry if no confirmation is ever seen).
        self.db.mark_leaf_as_processed(msg.leaf_index)?;

        Ok(())
    }
}
