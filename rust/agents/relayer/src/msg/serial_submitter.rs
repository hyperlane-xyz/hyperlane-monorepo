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

use hyperlane_base::CoreMetrics;
use hyperlane_core::HyperlaneDomain;

use super::pending_operation::*;

/// SerialSubmitter accepts operations over a channel. It is responsible for
/// executing the right strategy to deliver those messages to the destination
/// chain. It is designed to be used in a scenario allowing only one
/// simultaneously in-flight submission, a consequence imposed by strictly
/// ordered nonces at the target chain combined with a hesitancy to
/// speculatively batch > 1 messages with a sequence of nonces, which entails
/// harder to manage error recovery, could lead to head of line blocking, etc.
///
/// The single transaction execution slot is (likely) a bottlenecked resource
/// under steady state traffic, so the SerialSubmitter implemented in this file
/// carefully schedules work items onto the constrained
/// resource (transaction execution slot) according to a policy that
/// incorporates both user-visible metrics and message operation readiness
/// checks.
///
/// Operations which failed processing due to a retriable error are also
/// retained within the SerialSubmitter, and will eventually be retried
/// according to our prioritization rule.
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
/// retained them for retry). So we should attempt processing operations
/// (num_retries=0) before ones that have been failing for a
/// while (num_retries>0)
///
/// 2. Operations should be executed in in-order, i.e. if op_a was sent on
/// source chain prior to op_b, and they're both destined for the same
/// destination chain and are otherwise eligible, we should try to deliver op_a
/// before op_b, all else equal. This is because we expect applications may
/// prefer this even if they do not strictly rely on it for correctness.
///
/// 3. Be [work-conserving](https://en.wikipedia.org/wiki/Work-conserving_scheduler) w.r.t.
/// the single execution slot, i.e. so long as there is at least one message
/// eligible for submission, we should be working on it within reason. This
/// must be balanced with the cost of making RPCs that will almost certainly
/// fail and potentially block new messages from being sent immediately.
#[derive(Debug, new)]
pub struct SerialSubmitter {
    /// Domain this submitter delivers to.
    domain: HyperlaneDomain,
    /// Receiver for new messages to submit.
    rx: mpsc::UnboundedReceiver<Box<DynPendingOperation>>,
    // TODO: pipeline with another queue?
    /// Messages waiting for their turn to be dispatched. The SerialSubmitter
    /// can only dispatch one message at a time, so this queue could grow.
    #[new(default)]
    run_queue: BinaryHeap<Reverse<Box<DynPendingOperation>>>,
    #[new(default)]
    confirm_queue: BinaryHeap<Reverse<Box<DynPendingOperation>>>,
    /// Metrics for serial submitter.
    metrics: SerialSubmitterMetrics,
}

impl SerialSubmitter {
    pub fn spawn(mut self) -> Instrumented<JoinHandle<Result<()>>> {
        tokio::spawn(async move { self.work_loop().await })
            .instrument(info_span!("serial submitter work loop"))
    }

    #[instrument(skip_all, fields(domain=%self.domain))]
    async fn work_loop(&mut self) -> Result<()> {
        loop {
            self.tick_read().await?;
            self.update_metrics();
            self.tick_process().await?;
            self.update_metrics();
            self.tick_confirm().await?;
            self.update_metrics();
            sleep(Duration::from_millis(200)).await;
        }
    }

    /// Fetch any new operations from the channel.
    async fn tick_read(&mut self) -> Result<()> {
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
        Ok(())
    }

    /// Process pending operations.
    async fn tick_process(&mut self) -> Result<()> {
        // Pick the next message to try processing.
        let mut op = match self.run_queue.pop() {
            Some(op) => op.0,
            None => return Ok(()),
        };

        // make sure things are getting wired up correctly; if this works in testing it should also
        // be valid in production.
        debug_assert_eq!(*op.domain(), self.domain);

        // in the future we could pipeline this so that the next operation is being
        // prepared while the current one is being submitted
        match op.prepare().await {
            PendingOperationResult::Success => {
                self.metrics.txs_prepared.inc();
            }
            PendingOperationResult::NotReady => {
                self.run_queue.push(Reverse(op));
                return Ok(());
            }
            PendingOperationResult::Reprepare => {
                self.metrics.txs_failed.inc();
                self.run_queue.push(Reverse(op));
                return Ok(());
            }
            PendingOperationResult::Drop => {
                // not strictly an error, could have already been processed
                self.metrics.txs_prepared.inc();
                return Ok(());
            }
            PendingOperationResult::CriticalFailure(e) => {
                return Err(e);
            }
        }

        match op.submit().await {
            PendingOperationResult::Success => {
                self.metrics.txs_submitted.inc();
                self.confirm_queue.push(Reverse(op));
            }
            PendingOperationResult::NotReady => {
                self.run_queue.push(Reverse(op));
            }
            PendingOperationResult::Reprepare => {
                self.metrics.txs_failed.inc();
                self.run_queue.push(Reverse(op));
            }
            PendingOperationResult::Drop => {
                self.metrics.txs_submitted.inc();
            }
            PendingOperationResult::CriticalFailure(e) => return Err(e),
        }

        Ok(())
    }

    /// Confirm submitted operations.
    async fn tick_confirm(&mut self) -> Result<()> {
        while let Some(Reverse(mut op)) = self.confirm_queue.pop() {
            match op.confirm().await {
                PendingOperationResult::Success => {
                    self.metrics.txs_confirmed.inc();
                }
                PendingOperationResult::NotReady => {
                    self.confirm_queue.push(Reverse(op));
                    break;
                }
                PendingOperationResult::Reprepare => {
                    self.metrics.txs_reorged.inc();
                    self.run_queue.push(Reverse(op));
                }
                PendingOperationResult::Drop => {
                    self.metrics.txs_confirmed.inc();
                }
                PendingOperationResult::CriticalFailure(e) => return Err(e),
            }
        }

        Ok(())
    }

    fn update_metrics(&self) {
        self.metrics
            .run_queue_length
            .set(self.run_queue.len() as i64);
        self.metrics
            .confirm_queue_length
            .set(self.confirm_queue.len() as i64);
    }
}

#[derive(Debug)]
pub struct SerialSubmitterMetrics {
    run_queue_length: IntGauge,
    confirm_queue_length: IntGauge,

    txs_prepared: IntCounter,
    txs_submitted: IntCounter,
    txs_confirmed: IntCounter,
    txs_reorged: IntCounter,
    txs_failed: IntCounter,
}

impl SerialSubmitterMetrics {
    pub fn new(metrics: &CoreMetrics, destination: &HyperlaneDomain) -> Self {
        let destination = destination.name();
        Self {
            run_queue_length: metrics
                .submitter_queue_length()
                .with_label_values(&[destination, "run_queue"]),
            confirm_queue_length: metrics
                .submitter_queue_length()
                .with_label_values(&[destination, "confirm_queue"]),
            txs_prepared: metrics
                .transactions_processed_count()
                .with_label_values(&["prepared", destination]),
            txs_submitted: metrics
                .transactions_processed_count()
                .with_label_values(&["submitted", destination]),
            txs_confirmed: metrics
                .transactions_processed_count()
                .with_label_values(&["confirmed", destination]),
            txs_reorged: metrics
                .transactions_processed_count()
                .with_label_values(&["reorged", destination]),
            txs_failed: metrics
                .transactions_processed_count()
                .with_label_values(&["failed", destination]),
        }
    }
}
