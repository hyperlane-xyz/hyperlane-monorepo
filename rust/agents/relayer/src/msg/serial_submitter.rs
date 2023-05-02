use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::time::Duration;

use derive_new::new;
use eyre::{bail, Result};
use prometheus::{IntCounter, IntGauge};
use tokio::sync::mpsc::{self, error::TryRecvError};
use tokio::task::JoinHandle;
use tokio::time::sleep;
use tracing::{info_span, instrument, instrument::Instrumented, Instrument};

use hyperlane_base::{db::HyperlaneDB, CoreMetrics};
use hyperlane_core::HyperlaneDomain;

use super::pending_operation::*;

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
pub struct SerialSubmitter {
    /// Receiver for new messages to submit.
    rx: mpsc::UnboundedReceiver<Box<dyn PendingOperation>>,
    /// Messages waiting for their turn to be dispatched. The SerialSubmitter
    /// can only dispatch one message at a time, so this queue could grow.
    #[new(default)]
    run_queue: BinaryHeap<Reverse<Box<dyn PendingOperation>>>,
    #[new(default)]
    validation_queue: BinaryHeap<Reverse<Box<dyn PendingOperation>>>,
    /// Database for the origin domain
    db: HyperlaneDB,
    /// Metrics for serial submitter.
    metrics: SerialSubmitterMetrics,
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

        // Pick the next message to try processing.
        let mut op = match self.run_queue.pop() {
            Some(op) => op.0,
            None => return Ok(()),
        };

        // in the future we could pipeline this so that the next operation is being
        // prepared while the current one is being submitted
        match op.prepare().await {
            TxPrepareResult::Ready => {}
            TxPrepareResult::NotReady => {
                self.run_queue.push(Reverse(op));
                return Ok(());
            }
            TxPrepareResult::Retry => {
                self.metrics.txs_failed.inc();
                self.run_queue.push(Reverse(op));
                return Ok(());
            }
            TxPrepareResult::Failure => {
                self.metrics.txs_failed.inc();
                return Ok(());
            }
            TxPrepareResult::CriticalFailure(e) => {
                self.metrics.txs_failed.inc();
                return Err(e);
            }
        };

        match op.submit().await {
            TxRunResult::Success => self.metrics.txs_processed.inc(),
            TxRunResult::Failure => self.metrics.txs_failed.inc(),
            TxRunResult::Retry => {
                self.metrics.txs_failed.inc();
                self.run_queue.push(Reverse(op));
            }
            TxRunResult::CriticalFailure(e) => {
                self.metrics.txs_failed.inc();
                return Err(e);
            }
        }

        Ok(())
    }

    fn record_message_process_success(&mut self) -> Result<()> {
        self.metrics.txs_processed.inc();
        Ok(())
    }
}

#[derive(Debug)]
pub struct SerialSubmitterMetrics {
    run_queue_length_gauge: IntGauge,
    txs_processed: IntCounter,
}

impl SerialSubmitterMetrics {
    pub fn new(metrics: &CoreMetrics, destination: &HyperlaneDomain) -> Self {
        let origin = origin.name();
        let destination = destination.name();
        Self {
            run_queue_length_gauge: metrics.submitter_queue_length().with_label_values(&[
                origin,
                destination,
                "run_queue",
            ]),
            txs_processed: metrics
                .transactions_processed()
                .with_label_values(&[destination]),
        }
    }
}
