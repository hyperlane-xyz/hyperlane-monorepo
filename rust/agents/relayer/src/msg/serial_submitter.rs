use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::sync::Arc;
use std::time::Duration;

use derive_new::new;
use eyre::{bail, Result};
use futures_util::future::try_join_all;
use prometheus::{IntCounter, IntGauge};
use tokio::spawn;
use tokio::sync::mpsc::{self};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio::time::sleep;
use tracing::{info_span, instrument, instrument::Instrumented, Instrument};

use hyperlane_base::CoreMetrics;
use hyperlane_core::HyperlaneDomain;

use super::pending_operation::*;

type OpQueue = Arc<Mutex<BinaryHeap<Reverse<Box<DynPendingOperation>>>>>;

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
    /// Metrics for serial submitter.
    metrics: SerialSubmitterMetrics,
}

impl SerialSubmitter {
    pub fn spawn(self) -> Instrumented<JoinHandle<Result<()>>> {
        let span = info_span!("SerialSubmitter", destination=%self.domain);
        spawn(async move { self.run().await }).instrument(span)
    }

    async fn run(self) -> Result<()> {
        let Self {
            domain,
            metrics,
            rx: rx_prepare,
        } = self;
        let prepare_queue: OpQueue = Default::default();
        let confirm_queue: OpQueue = Default::default();

        let (tx_submit, rx_submit) = mpsc::channel(1);

        let tasks = [
            spawn(receive_task(domain, rx_prepare, prepare_queue.clone())),
            spawn(prepare_task(
                tx_submit,
                prepare_queue.clone(),
                metrics.clone(),
            )),
            spawn(submit_task(
                rx_submit,
                prepare_queue.clone(),
                confirm_queue.clone(),
                metrics.clone(),
            )),
            spawn(confirm_task(prepare_queue, confirm_queue, metrics)),
        ];

        for i in try_join_all(tasks).await? {
            i?;
        }
        Ok(())
    }
}

#[instrument(skip_all)]
async fn receive_task(
    domain: HyperlaneDomain,
    mut rx: mpsc::UnboundedReceiver<Box<DynPendingOperation>>,
    prepare_queue: OpQueue,
) -> Result<()> {
    // Pull any messages sent to this submitter
    while let Some(op) = rx.recv().await {
        // make sure things are getting wired up correctly; if this works in testing it
        // should also be valid in production.
        debug_assert_eq!(*op.domain(), domain);
        prepare_queue.lock().await.push(Reverse(op));
    }
    bail!("Submitter receive channel was closed")
}

#[instrument(skip_all)]
async fn prepare_task(
    tx_submit: mpsc::Sender<Box<DynPendingOperation>>,
    prepare_queue: OpQueue,
    metrics: SerialSubmitterMetrics,
) -> Result<()> {
    loop {
        // Pick the next message to try preparing.
        let next = {
            let mut queue = prepare_queue.lock().await;
            metrics.prepare_queue_length.set(queue.len() as i64);
            queue.pop()
        };
        let Some(Reverse(mut op)) = next else {
            sleep(Duration::from_millis(200)).await;
            continue;
        };

        match op.prepare().await {
            PendingOperationResult::Success => {
                metrics.txs_prepared.inc();
                // this send will pause this task if the submitter is not ready to accept yet
                tx_submit.send(op).await?;
            }
            PendingOperationResult::NotReady => {
                // none of the operations are ready yet, so wait for a little bit
                prepare_queue.lock().await.push(Reverse(op));
                sleep(Duration::from_millis(200)).await;
            }
            PendingOperationResult::Reprepare => {
                metrics.txs_failed.inc();
                prepare_queue.lock().await.push(Reverse(op));
            }
            PendingOperationResult::Drop => {
                // not strictly an error, could have already been processed
                metrics.txs_prepared.inc();
            }
            PendingOperationResult::CriticalFailure(e) => {
                return Err(e);
            }
        }
    }
}

#[instrument(skip_all)]
async fn submit_task(
    mut rx_submit: mpsc::Receiver<Box<DynPendingOperation>>,
    prepare_queue: OpQueue,
    confirm_queue: OpQueue,
    metrics: SerialSubmitterMetrics,
) -> Result<()> {
    while let Some(mut op) = rx_submit.recv().await {
        match op.submit().await {
            PendingOperationResult::Success => {
                metrics.txs_submitted.inc();
                confirm_queue.lock().await.push(Reverse(op));
            }
            PendingOperationResult::NotReady => {
                panic!("Pending operation was prepared and therefore must be ready")
            }
            PendingOperationResult::Reprepare => {
                metrics.txs_failed.inc();
                prepare_queue.lock().await.push(Reverse(op));
            }
            PendingOperationResult::Drop => {
                metrics.txs_submitted.inc();
            }
            PendingOperationResult::CriticalFailure(e) => return Err(e),
        }
    }
    bail!("Internal submitter channel was closed");
}

#[instrument(skip_all)]
async fn confirm_task(
    prepare_queue: OpQueue,
    confirm_queue: OpQueue,
    metrics: SerialSubmitterMetrics,
) -> Result<()> {
    loop {
        // Pick the next message to try confirming.
        let next = {
            let mut queue = confirm_queue.lock().await;
            metrics.confirm_queue_length.set(queue.len() as i64);
            queue.pop()
        };
        let Some(Reverse(mut op)) = next else {
            sleep(Duration::from_millis(1000)).await;
            continue;
        };

        match op.confirm().await {
            PendingOperationResult::Success => {
                metrics.txs_confirmed.inc();
            }
            PendingOperationResult::NotReady => {
                // none of the operations are ready yet, so wait for a little bit
                confirm_queue.lock().await.push(Reverse(op));
                sleep(Duration::from_millis(1000)).await;
            }
            PendingOperationResult::Reprepare => {
                metrics.txs_reorged.inc();
                prepare_queue.lock().await.push(Reverse(op));
            }
            PendingOperationResult::Drop => {
                metrics.txs_confirmed.inc();
            }
            PendingOperationResult::CriticalFailure(e) => return Err(e),
        }
    }
}

#[derive(Debug, Clone)]
pub struct SerialSubmitterMetrics {
    prepare_queue_length: IntGauge,
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
            prepare_queue_length: metrics
                .submitter_queue_length()
                .with_label_values(&[destination, "prepare_queue"]),
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
