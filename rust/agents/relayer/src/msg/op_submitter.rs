use std::sync::Arc;
use std::time::Duration;

use derive_new::new;
use futures::future::join_all;
use futures_util::future::try_join_all;
use hyperlane_core::total_estimated_cost;
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
    BatchItem, ChainCommunicationError, ChainResult, HyperlaneDomain, HyperlaneDomainProtocol,
    HyperlaneMessage, PendingOperationResult, QueueOperation, TxOutcome,
};

use crate::msg::pending_message::CONFIRM_DELAY;
use crate::server::MessageRetryRequest;

use super::op_queue::OpQueue;

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
#[derive(Debug, new)]
pub struct SerialSubmitter {
    /// Domain this submitter delivers to.
    domain: HyperlaneDomain,
    /// Receiver for new messages to submit.
    rx: mpsc::UnboundedReceiver<QueueOperation>,
    /// Receiver for retry requests.
    retry_tx: Sender<MessageRetryRequest>,
    /// Metrics for serial submitter.
    metrics: SerialSubmitterMetrics,
    /// Max batch size for submitting messages
    max_batch_size: u32,
    /// tokio task monitor
    task_monitor: TaskMonitor,
}

impl SerialSubmitter {
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
            retry_tx,
            max_batch_size,
            task_monitor,
        } = self;
        let prepare_queue = OpQueue::new(
            metrics.submitter_queue_length.clone(),
            "prepare_queue".to_string(),
            Arc::new(Mutex::new(retry_tx.subscribe())),
        );
        let submit_queue = OpQueue::new(
            metrics.submitter_queue_length.clone(),
            "submit_queue".to_string(),
            Arc::new(Mutex::new(retry_tx.subscribe())),
        );
        let confirm_queue = OpQueue::new(
            metrics.submitter_queue_length.clone(),
            "confirm_queue".to_string(),
            Arc::new(Mutex::new(retry_tx.subscribe())),
        );

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
        prepare_queue.push(op).await;
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
                    PendingOperationResult::NotReady | PendingOperationResult::Reprepare
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
                    submit_queue.push(op).await;
                }
                PendingOperationResult::NotReady => {
                    prepare_queue.push(op).await;
                }
                PendingOperationResult::Reprepare => {
                    metrics.ops_failed.inc();
                    prepare_queue.push(op).await;
                }
                PendingOperationResult::Drop => {
                    metrics.ops_dropped.inc();
                }
                PendingOperationResult::Confirm => {
                    debug!(?op, "Pushing operation to confirm queue");
                    confirm_queue.push(op).await;
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
                submit_single_operation(op, &mut confirm_queue, &metrics).await;
            }
            std::cmp::Ordering::Greater => {
                OperationBatch::new(batch, domain.clone())
                    .submit(&mut confirm_queue, &metrics)
                    .await;
            }
        }
    }
}

#[instrument(skip(confirm_queue, metrics), ret, level = "debug")]
async fn submit_single_operation(
    mut op: QueueOperation,
    confirm_queue: &mut OpQueue,
    metrics: &SerialSubmitterMetrics,
) {
    let destination = op.destination_domain().clone();
    op.submit().await;
    debug!(?op, "Operation submitted");
    op.set_next_attempt_after(CONFIRM_DELAY);
    confirm_queue.push(op).await;
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
                PendingOperationResult::NotReady | PendingOperationResult::Confirm
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
    match operation_result {
        PendingOperationResult::Success => {
            debug!(?op, "Operation confirmed");
            metrics.ops_confirmed.inc();
        }
        PendingOperationResult::NotReady | PendingOperationResult::Confirm => {
            // TODO: push multiple messages at once
            confirm_queue.push(op).await;
        }
        PendingOperationResult::Reprepare => {
            metrics.ops_failed.inc();
            prepare_queue.push(op).await;
        }
        PendingOperationResult::Drop => {
            metrics.ops_dropped.inc();
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
    async fn submit(self, confirm_queue: &mut OpQueue, metrics: &SerialSubmitterMetrics) {
        match self.try_submit_as_batch(metrics).await {
            Ok(outcome) => {
                info!(outcome=?outcome, batch_size=self.operations.len(), batch=?self.operations, "Submitted transaction batch");
                let total_estimated_cost = total_estimated_cost(&self.operations);
                for mut op in self.operations {
                    op.set_operation_outcome(outcome.clone(), total_estimated_cost);
                    op.set_next_attempt_after(CONFIRM_DELAY);
                    confirm_queue.push(op).await;
                }
                return;
            }
            Err(e) => {
                warn!(error=?e, batch=?self.operations, "Error when submitting batch. Falling back to serial submission.");
            }
        }
        self.submit_serially(confirm_queue, metrics).await;
    }

    #[instrument(skip(metrics), ret, level = "debug")]
    async fn try_submit_as_batch(
        &self,
        metrics: &SerialSubmitterMetrics,
    ) -> ChainResult<TxOutcome> {
        let batch = self
            .operations
            .iter()
            .map(|op| op.try_batch())
            .collect::<ChainResult<Vec<BatchItem<HyperlaneMessage>>>>()?;

        // We already assume that the relayer submits to a single mailbox per destination.
        // So it's fine to use the first item in the batch to get the mailbox.
        let Some(first_item) = batch.first() else {
            return Err(ChainCommunicationError::BatchIsEmpty);
        };

        let outcome = first_item.mailbox.process_batch(&batch).await?;
        metrics.ops_submitted.inc_by(self.operations.len() as u64);
        Ok(outcome)
    }

    async fn submit_serially(self, confirm_queue: &mut OpQueue, metrics: &SerialSubmitterMetrics) {
        for op in self.operations.into_iter() {
            submit_single_operation(op, confirm_queue, metrics).await;
        }
    }
}
