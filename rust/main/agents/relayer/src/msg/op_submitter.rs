#![allow(clippy::doc_markdown)] // TODO: `rustc` 1.80.1 clippy issue
#![allow(clippy::doc_lazy_continuation)] // TODO: `rustc` 1.80.1 clippy issue

use std::sync::Arc;
use std::time::Duration;

use derive_new::new;
use futures::future::join_all;
use futures_util::future::try_join_all;
use hyperlane_core::total_estimated_cost;
use hyperlane_core::BatchResult;
use hyperlane_core::ConfirmReason::*;
use hyperlane_core::PendingOperation;
use hyperlane_core::PendingOperationStatus;
use hyperlane_core::ReprepareReason;
use itertools::Either;
use itertools::Itertools;
use prometheus::{IntCounter, IntGaugeVec};
use tokio::sync::broadcast::Sender;
use tokio::sync::mpsc;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio::time::sleep;
use tokio_metrics::TaskMonitor;
use tracing::{debug, info_span, instrument, instrument::Instrumented, trace, Instrument};
use tracing::{info, warn};

use hyperlane_base::CoreMetrics;
use hyperlane_core::{
    ChainCommunicationError, ChainResult, HyperlaneDomain, HyperlaneDomainProtocol,
    PendingOperationResult, QueueOperation, TxOutcome,
};

use crate::msg::pending_message::CONFIRM_DELAY;
use crate::server::MessageRetryRequest;

use super::op_queue::OpQueue;
use super::op_queue::OperationPriorityQueue;

/// This is needed for logic where we need to allocate
/// based on how many queues exist in each OpSubmitter.
/// This value needs to be manually updated if we ever
/// update the number of queues an OpSubmitter has.
pub const SUBMITTER_QUEUE_COUNT: usize = 3;

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
/// HyperlaneRocksDB.
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
#[derive(Debug)]
pub struct SerialSubmitter {
    /// Domain this submitter delivers to.
    domain: HyperlaneDomain,
    /// Receiver for new messages to submit.
    rx: mpsc::UnboundedReceiver<QueueOperation>,
    /// Metrics for serial submitter.
    metrics: SerialSubmitterMetrics,
    /// Max batch size for submitting messages
    max_batch_size: u32,
    /// tokio task monitor
    task_monitor: TaskMonitor,
    prepare_queue: OpQueue,
    submit_queue: OpQueue,
    confirm_queue: OpQueue,
}

impl SerialSubmitter {
    pub fn new(
        domain: HyperlaneDomain,
        rx: mpsc::UnboundedReceiver<QueueOperation>,
        retry_op_transmitter: &Sender<MessageRetryRequest>,
        metrics: SerialSubmitterMetrics,
        max_batch_size: u32,
        task_monitor: TaskMonitor,
    ) -> Self {
        let prepare_queue = OpQueue::new(
            metrics.submitter_queue_length.clone(),
            "prepare_queue".to_string(),
            Arc::new(Mutex::new(retry_op_transmitter.subscribe())),
        );
        let submit_queue = OpQueue::new(
            metrics.submitter_queue_length.clone(),
            "submit_queue".to_string(),
            Arc::new(Mutex::new(retry_op_transmitter.subscribe())),
        );
        let confirm_queue = OpQueue::new(
            metrics.submitter_queue_length.clone(),
            "confirm_queue".to_string(),
            Arc::new(Mutex::new(retry_op_transmitter.subscribe())),
        );

        Self {
            domain,
            rx,
            metrics,
            max_batch_size,
            task_monitor,
            prepare_queue,
            submit_queue,
            confirm_queue,
        }
    }

    pub async fn prepare_queue(&self) -> OperationPriorityQueue {
        self.prepare_queue.queue.clone()
    }

    pub fn spawn(self) -> Instrumented<JoinHandle<()>> {
        let span = info_span!("SerialSubmitter", destination=%self.domain);
        let task_monitor = self.task_monitor.clone();
        tokio::spawn(TaskMonitor::instrument(&task_monitor, async move {
            self.run().await
        }))
        .instrument(span)
    }

    async fn run(self) {
        let Self {
            domain,
            metrics,
            rx: rx_prepare,
            max_batch_size,
            task_monitor,
            prepare_queue,
            submit_queue,
            confirm_queue,
        } = self;

        let tasks = [
            tokio::spawn(TaskMonitor::instrument(
                &task_monitor,
                receive_task(domain.clone(), rx_prepare, prepare_queue.clone()),
            )),
            tokio::spawn(TaskMonitor::instrument(
                &task_monitor,
                prepare_task(
                    domain.clone(),
                    prepare_queue.clone(),
                    submit_queue.clone(),
                    confirm_queue.clone(),
                    max_batch_size,
                    metrics.clone(),
                ),
            )),
            tokio::spawn(TaskMonitor::instrument(
                &task_monitor,
                submit_task(
                    domain.clone(),
                    prepare_queue.clone(),
                    submit_queue,
                    confirm_queue.clone(),
                    max_batch_size,
                    metrics.clone(),
                ),
            )),
            tokio::spawn(TaskMonitor::instrument(
                &task_monitor,
                confirm_task(
                    domain.clone(),
                    prepare_queue,
                    confirm_queue,
                    max_batch_size,
                    metrics,
                ),
            )),
        ];

        if let Err(err) = try_join_all(tasks).await {
            tracing::error!(
                error=?err,
                ?domain,
                "SerialSubmitter task panicked for domain"
            );
        }
    }
}

#[instrument(skip_all, fields(%domain))]
async fn receive_task(
    domain: HyperlaneDomain,
    mut rx: mpsc::UnboundedReceiver<QueueOperation>,
    prepare_queue: OpQueue,
) {
    // Pull any messages sent to this submitter
    while let Some(op) = rx.recv().await {
        trace!(?op, "Received new operation");
        // make sure things are getting wired up correctly; if this works in testing it
        // should also be valid in production.
        debug_assert_eq!(*op.destination_domain(), domain);
        let op_status = op.status();
        prepare_queue.push(op, Some(op_status)).await;
    }
}

#[instrument(skip_all, fields(%domain))]
async fn prepare_task(
    domain: HyperlaneDomain,
    mut prepare_queue: OpQueue,
    submit_queue: OpQueue,
    confirm_queue: OpQueue,
    max_batch_size: u32,
    metrics: SerialSubmitterMetrics,
) {
    // Prepare at most `max_batch_size` ops at a time to avoid getting rate-limited
    let ops_to_prepare = max_batch_size as usize;
    loop {
        // Pop messages here according to the configured batch.
        let mut batch = prepare_queue.pop_many(ops_to_prepare).await;
        if batch.is_empty() {
            // queue is empty so give some time before checking again to prevent burning CPU
            sleep(Duration::from_millis(100)).await;
            continue;
        }
        let mut task_prep_futures = vec![];
        let op_refs = batch.iter_mut().map(|op| op.as_mut()).collect::<Vec<_>>();
        for op in op_refs {
            trace!(?op, "Preparing operation");
            debug_assert_eq!(*op.destination_domain(), domain);
            task_prep_futures.push(op.prepare());
        }
        let res = join_all(task_prep_futures).await;
        let not_ready_count = res
            .iter()
            .filter(|r| {
                matches!(
                    r,
                    PendingOperationResult::NotReady | PendingOperationResult::Reprepare(_)
                )
            })
            .count();
        let batch_len = batch.len();
        for (op, prepare_result) in batch.into_iter().zip(res.into_iter()) {
            match prepare_result {
                PendingOperationResult::Success => {
                    debug!(?op, "Operation prepared");
                    metrics.ops_prepared.inc();
                    // TODO: push multiple messages at once
                    submit_queue
                        .push(op, Some(PendingOperationStatus::ReadyToSubmit))
                        .await;
                }
                PendingOperationResult::NotReady => {
                    prepare_queue.push(op, None).await;
                }
                PendingOperationResult::Reprepare(reason) => {
                    metrics.ops_failed.inc();
                    prepare_queue
                        .push(op, Some(PendingOperationStatus::Retry(reason)))
                        .await;
                }
                PendingOperationResult::Drop => {
                    metrics.ops_dropped.inc();
                    op.decrement_metric_if_exists();
                }
                PendingOperationResult::Confirm(reason) => {
                    debug!(?op, "Pushing operation to confirm queue");
                    confirm_queue
                        .push(op, Some(PendingOperationStatus::Confirm(reason)))
                        .await;
                }
            }
        }
        if not_ready_count == batch_len {
            // none of the operations are ready yet, so wait for a little bit
            sleep(Duration::from_millis(500)).await;
        }
    }
}

#[instrument(skip_all, fields(%domain))]
async fn submit_task(
    domain: HyperlaneDomain,
    mut prepare_queue: OpQueue,
    mut submit_queue: OpQueue,
    mut confirm_queue: OpQueue,
    max_batch_size: u32,
    metrics: SerialSubmitterMetrics,
) {
    let recv_limit = max_batch_size as usize;
    loop {
        let mut batch = submit_queue.pop_many(recv_limit).await;

        match batch.len().cmp(&1) {
            std::cmp::Ordering::Less => {
                // The queue is empty, so give some time before checking again to prevent burning CPU
                sleep(Duration::from_millis(100)).await;
                continue;
            }
            std::cmp::Ordering::Equal => {
                let op = batch.pop().unwrap();
                submit_single_operation(op, &mut prepare_queue, &mut confirm_queue, &metrics).await;
            }
            std::cmp::Ordering::Greater => {
                OperationBatch::new(batch, domain.clone())
                    .submit(&mut prepare_queue, &mut confirm_queue, &metrics)
                    .await;
            }
        }
    }
}

#[instrument(skip(prepare_queue, confirm_queue, metrics), ret, level = "debug")]
async fn submit_single_operation(
    mut op: QueueOperation,
    prepare_queue: &mut OpQueue,
    confirm_queue: &mut OpQueue,
    metrics: &SerialSubmitterMetrics,
) {
    let status = op.submit().await;
    match status {
        PendingOperationResult::Reprepare(reprepare_reason) => {
            prepare_queue
                .push(op, Some(PendingOperationStatus::Retry(reprepare_reason)))
                .await;
        }
        PendingOperationResult::NotReady => {
            // This `match` arm isn't expected to be hit, but it's here for completeness,
            // hence the hardcoded `ReprepareReason`
            prepare_queue
                .push(
                    op,
                    Some(PendingOperationStatus::Retry(
                        ReprepareReason::ErrorSubmitting,
                    )),
                )
                .await;
        }
        PendingOperationResult::Drop => {
            // Not expected to hit this case in `submit`, but it's here for completeness
            op.decrement_metric_if_exists();
        }
        PendingOperationResult::Success | PendingOperationResult::Confirm(_) => {
            confirm_op(op, confirm_queue, metrics).await
        }
    }
}

async fn confirm_op(
    mut op: QueueOperation,
    confirm_queue: &mut OpQueue,
    metrics: &SerialSubmitterMetrics,
) {
    let destination = op.destination_domain().clone();
    debug!(?op, "Operation submitted");
    op.set_next_attempt_after(CONFIRM_DELAY);
    confirm_queue
        .push(op, Some(PendingOperationStatus::Confirm(SubmittedBySelf)))
        .await;
    metrics.ops_submitted.inc();

    if matches!(
        destination.domain_protocol(),
        HyperlaneDomainProtocol::Cosmos
    ) {
        // On cosmos chains, sleep for 1 sec (the finality period).
        // Otherwise we get `account sequence mismatch` errors, which have caused us
        // to lose liveness.
        sleep(Duration::from_secs(1)).await;
    }
}

#[instrument(skip_all, fields(%domain))]
async fn confirm_task(
    domain: HyperlaneDomain,
    prepare_queue: OpQueue,
    mut confirm_queue: OpQueue,
    max_batch_size: u32,
    metrics: SerialSubmitterMetrics,
) {
    let recv_limit = max_batch_size as usize;
    loop {
        // Pick the next message to try confirming.
        let batch = confirm_queue.pop_many(recv_limit).await;

        if batch.is_empty() {
            // queue is empty so give some time before checking again to prevent burning CPU
            sleep(Duration::from_millis(200)).await;
            continue;
        }

        let futures = batch.into_iter().map(|op| {
            confirm_operation(
                op,
                domain.clone(),
                prepare_queue.clone(),
                confirm_queue.clone(),
                metrics.clone(),
            )
        });
        let op_results = join_all(futures).await;
        if op_results.iter().all(|op| {
            matches!(
                op,
                PendingOperationResult::NotReady | PendingOperationResult::Confirm(_)
            )
        }) {
            // None of the operations are ready, so wait for a little bit
            // before checking again to prevent burning CPU
            sleep(Duration::from_millis(500)).await;
        }
    }
}

async fn confirm_operation(
    mut op: QueueOperation,
    domain: HyperlaneDomain,
    prepare_queue: OpQueue,
    confirm_queue: OpQueue,
    metrics: SerialSubmitterMetrics,
) -> PendingOperationResult {
    trace!(?op, "Confirming operation");
    debug_assert_eq!(*op.destination_domain(), domain);

    let operation_result = op.confirm().await;
    match &operation_result {
        PendingOperationResult::Success => {
            debug!(?op, "Operation confirmed");
            metrics.ops_confirmed.inc();
            op.decrement_metric_if_exists();
        }
        PendingOperationResult::NotReady => {
            confirm_queue.push(op, None).await;
        }
        PendingOperationResult::Confirm(reason) => {
            // TODO: push multiple messages at once
            confirm_queue
                .push(op, Some(PendingOperationStatus::Confirm(reason.clone())))
                .await;
        }
        PendingOperationResult::Reprepare(reason) => {
            metrics.ops_failed.inc();
            prepare_queue
                .push(op, Some(PendingOperationStatus::Retry(reason.clone())))
                .await;
        }
        PendingOperationResult::Drop => {
            metrics.ops_dropped.inc();
            op.decrement_metric_if_exists();
        }
    }
    operation_result
}

#[derive(Debug, Clone)]
pub struct SerialSubmitterMetrics {
    submitter_queue_length: IntGaugeVec,
    ops_prepared: IntCounter,
    ops_submitted: IntCounter,
    ops_confirmed: IntCounter,
    ops_failed: IntCounter,
    ops_dropped: IntCounter,
}

impl SerialSubmitterMetrics {
    pub fn new(metrics: &CoreMetrics, destination: &HyperlaneDomain) -> Self {
        let destination = destination.name();
        Self {
            submitter_queue_length: metrics.submitter_queue_length(),
            ops_prepared: metrics
                .operations_processed_count()
                .with_label_values(&["prepared", destination]),
            ops_submitted: metrics
                .operations_processed_count()
                .with_label_values(&["submitted", destination]),
            ops_confirmed: metrics
                .operations_processed_count()
                .with_label_values(&["confirmed", destination]),
            ops_failed: metrics
                .operations_processed_count()
                .with_label_values(&["failed", destination]),
            ops_dropped: metrics
                .operations_processed_count()
                .with_label_values(&["dropped", destination]),
        }
    }
}

#[derive(new, Debug)]
struct OperationBatch {
    operations: Vec<QueueOperation>,
    #[allow(dead_code)]
    domain: HyperlaneDomain,
}

impl OperationBatch {
    async fn submit(
        self,
        prepare_queue: &mut OpQueue,
        confirm_queue: &mut OpQueue,
        metrics: &SerialSubmitterMetrics,
    ) {
        let excluded_ops = match self.try_submit_as_batch(metrics).await {
            Ok(batch_result) => {
                Self::handle_batch_result(self.operations, batch_result, confirm_queue).await
            }
            Err(e) => {
                warn!(error=?e, batch=?self.operations, "Error when submitting batch");
                self.operations
            }
        };

        if !excluded_ops.is_empty() {
            warn!(excluded_ops=?excluded_ops, "Either operations reverted in the batch or the txid wasn't included. Falling back to serial submission.");
            OperationBatch::new(excluded_ops, self.domain)
                .submit_serially(prepare_queue, confirm_queue, metrics)
                .await;
        }
    }

    #[instrument(skip(metrics), ret, level = "debug")]
    async fn try_submit_as_batch(
        &self,
        metrics: &SerialSubmitterMetrics,
    ) -> ChainResult<BatchResult> {
        // We already assume that the relayer submits to a single mailbox per destination.
        // So it's fine to use the first item in the batch to get the mailbox.
        let Some(first_item) = self.operations.first() else {
            return Err(ChainCommunicationError::BatchIsEmpty);
        };
        let outcome = if let Some(mailbox) = first_item.try_get_mailbox() {
            mailbox
                .try_process_batch(self.operations.iter().collect_vec())
                .await?
        } else {
            BatchResult::failed(self.operations.len())
        };
        let ops_submitted = self.operations.len() - outcome.failed_indexes.len();
        metrics.ops_submitted.inc_by(ops_submitted as u64);
        Ok(outcome)
    }

    /// Process the operations sent by a batch.
    /// Returns the operations that were not sent
    async fn handle_batch_result(
        operations: Vec<QueueOperation>,
        batch_result: BatchResult,
        confirm_queue: &mut OpQueue,
    ) -> Vec<Box<dyn PendingOperation>> {
        let (sent_ops, excluded_ops): (Vec<_>, Vec<_>) =
            operations.into_iter().enumerate().partition_map(|(i, op)| {
                if !batch_result.failed_indexes.contains(&i) {
                    Either::Left(op)
                } else {
                    Either::Right(op)
                }
            });

        if let Some(outcome) = batch_result.outcome {
            info!(batch_size=sent_ops.len(), outcome=?outcome, batch=?sent_ops, ?excluded_ops, "Submitted transaction batch");
            Self::update_sent_ops_state(sent_ops, outcome, confirm_queue).await;
        }
        excluded_ops
    }

    async fn update_sent_ops_state(
        sent_ops: Vec<Box<dyn PendingOperation>>,
        outcome: TxOutcome,
        confirm_queue: &mut OpQueue,
    ) {
        let total_estimated_cost = total_estimated_cost(sent_ops.as_slice());
        for mut op in sent_ops {
            op.set_operation_outcome(outcome.clone(), total_estimated_cost);
            op.set_next_attempt_after(CONFIRM_DELAY);
            confirm_queue
                .push(op, Some(PendingOperationStatus::Confirm(SubmittedBySelf)))
                .await;
        }
    }

    async fn submit_serially(
        self,
        prepare_queue: &mut OpQueue,
        confirm_queue: &mut OpQueue,
        metrics: &SerialSubmitterMetrics,
    ) {
        for op in self.operations.into_iter() {
            submit_single_operation(op, prepare_queue, confirm_queue, metrics).await;
        }
    }
}
