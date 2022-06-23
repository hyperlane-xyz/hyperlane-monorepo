use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::sync::Arc;

use crate::merkle_tree_builder::MerkleTreeBuilder;
use crate::msg::SubmitMessageOp;
use abacus_base::{CachingInterchainGasPaymaster, InboxContracts, Outboxes};
use abacus_core::db::AbacusDB;
use abacus_core::MultisigSignedCheckpoint;
use eyre::{bail, Result};
use tokio::task::JoinHandle;
use tokio::{
    sync::{mpsc, watch},
    time::Instant,
};
use tracing::warn;
use tracing::{info, info_span, instrument::Instrumented, Instrument};


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
/// 
/// 


// TODO(webbhorn): Take dep on interchain gas paymaster indexed data.
// TODO(webbhorn): Metrics data.

#[allow(dead_code)]
#[derive(Debug)]
pub(crate) struct SerialSubmitter {
    // Receiver for new messages to submit.
    rx: mpsc::Receiver<SubmitMessageOp>,
    // Provides access to most-recently available signed checkpoint.
    signed_checkpoint_receiver: watch::Receiver<Option<MultisigSignedCheckpoint>>,
    // Messages we are aware of that we want to eventually submit,
    // but haven't yet, for whatever reason. They are not in any
    // priority order, so are held in a vector.
    retry_queue: Vec<SubmitMessageOp>,
    // Messages that are in theory deliverable, but which are waiting in a queue for
    // their turn to be dispatched. The SerialSubmitter can only dispatch one message
    // at a time, so this queue could grow.
    runnable_queue: BinaryHeap<SubmitMessageOp>,
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
    // Interface to generating merkle proofs for messages against a checkpoint.
    prover_sync: MerkleTreeBuilder,
}

impl SerialSubmitter {
    pub(crate) fn new(
        rx: mpsc::Receiver<SubmitMessageOp>,
        inbox_contracts: InboxContracts,
        outbox: Outboxes,
        interchain_gas_paymaster: Option<Arc<CachingInterchainGasPaymaster>>,
        max_retries: u32,
        db: AbacusDB,
        signed_checkpoint_receiver: watch::Receiver<Option<MultisigSignedCheckpoint>>,
    ) -> Self {
        Self {
            rx,
            signed_checkpoint_receiver,
            retry_queue: Vec::new(),
            runnable_queue: BinaryHeap::new(),
            inbox_contracts,
            outbox,
            interchain_gas_paymaster,
            max_retries,
            db: db.clone(),
            prover_sync: MerkleTreeBuilder::new(db),
        }
    }

    pub fn spawn(mut self) -> Instrumented<JoinHandle<Result<()>>> {
        tokio::spawn(async move { self.work_loop().await })
            .instrument(info_span!("submitter work loop"))
    }

    async fn work_loop(&mut self) -> Result<()> {
        loop {
            // We maintain the invariant that each iteration of this loop begins and ends with
            // an empty runnable queue, since we do not want to let the task wait for an
            // arbitrarily long time in tokio::select! while there's useful work we already
            // know we could be doing.
            assert!(self.runnable_queue.is_empty());
            
            // The runnable_queue is currently empty, although there may be pending messages on
            // the retry_queue. The only way for a message on the retry queue to be promoted to
            // the runnable queue is if some external condition changes that makes them become
            // runnable. Currently, our only two criteria for this are:
            //     (1) a new signed checkpoint covering a higher leaf index, and
            //     (2) a new message arriving that might be immediately eligible for delivery.
            // Therefore, wait until we get a signal that either of these events may have
            // occurred. Until then, there's nothing to be done.
            tokio::select! {
                // Place the new message on the retry queue initially.
                // If in fact it is runnable, we will immediately discover that fact and
                // promote it to the runnable queue below.
                Some(new_msg) = self.rx.recv() => {
                    info!(msg=?new_msg, "new message avail");
                    self.retry_queue.push(new_msg);
                },
                // If a new checkpoint is available, some messages on the retry queue
                // might be promotable to the runnable queue.
                Ok(_) = self.signed_checkpoint_receiver.changed() => {
                    info!(ckpt=?self.signed_checkpoint_receiver.borrow(),
                        "new signed checkpoint avail");
                },
                // It's unclear under what cirucmstances this would happen, but there's also no
                // clear way to recover from whatever error could trigger this situation.
                // Without recovery, the relayer would  no longer be functionally delivering
                // messages, so for now bailing seems like the simplest and most explicit
                // option.
                else => {
                    bail!("unexpected work loop select! error, bailing")
                }

                // TODO(webbhorn): Since we probably won't be able to rely on a channel
                // to receive gas price updates on source chain's interchain gas paymaster
                // we will probably eventually want to add a simple time-based wakeup here
                // too, so that we'll look for any newly-runnable messages on the retry
                // queue that are now runnable because of a gas paymaster udpate.
            };

            loop {
                // Invariant: whenever we enter or leave this loop, runnable_queue is empty.
                // Within the loop, we may promote some messages from retryable to runnable,
                // and then attempt submission for each of those.
                info!(retry_queue=?self.retry_queue, "pre-scan retry queue state");
                info!(runnable_queue=?self.retry_queue, "pre-scan runnable queue state");
                assert!(self.runnable_queue.is_empty());

                let ckpt = match self.signed_checkpoint_receiver.borrow().clone() {
                    Some(ckpt) => ckpt,
                    None => {
                        warn!("no signed checkpoint actually available");
                        break;
                    },
                };
                info!(ckpt=?ckpt);

                self.process_retryable(&ckpt).await?;
                self.process_runnable(&ckpt).await?;

                // If runnable queue is empty and there's no new checkpoint at a higher
                // index, exit the loop and wait for more work via tokio::select!.
                // Otherwise, there might still be eligible work sitting in the retry queue,
                // so loop back around to rescan the retry queue and then run anything in the
                // runnable queue.
                match self.signed_checkpoint_receiver.borrow().clone() {
                    Some(new_ckpt) if self.runnable_queue.is_empty() => {
                        if new_ckpt.checkpoint.index <= ckpt.checkpoint.index {
                            break;
                        }
                    },
                    _ => {},
                }
            }
            assert!(self.runnable_queue.is_empty());
        }
    }

    async fn process_retryable(&self, ckpt: &MultisigSignedCheckpoint) -> Result<()> {
        todo!()
    }

    async fn process_runnable(&self, ckpt: &MultisigSignedCheckpoint) -> Result<()> {
        todo!()
    }
}

#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
struct MessageToRetry {
    time_to_retry: Reverse<Instant>,
    leaf_index: u32,
    retries: u32,
}
