#![allow(clippy::doc_markdown)] // TODO: `rustc` 1.80.1 clippy issue
#![allow(clippy::doc_lazy_continuation)] // TODO: `rustc` 1.80.1 clippy issue

use std::fmt::Debug;
use std::sync::Arc;
use std::time::Duration;

use futures::future::join_all;
use futures_util::future::try_join_all;
use num_traits::Zero;
use prometheus::{IntCounter, IntGaugeVec};
use tokio::sync::{broadcast::Sender, mpsc, Mutex};
use tokio::task::JoinHandle;
use tokio::time::sleep;
use tokio_metrics::TaskMonitor;
use tracing::{debug, error, info, info_span, instrument, trace, warn, Instrument};

use hyperlane_base::db::{HyperlaneDb, HyperlaneRocksDB};
use hyperlane_base::CoreMetrics;
use hyperlane_core::{
    ConfirmReason, HyperlaneDomain, HyperlaneDomainProtocol, PendingOperationResult,
    PendingOperationStatus, QueueOperation, ReprepareReason,
};
use submitter::{
    Entrypoint, FullPayload, PayloadDispatcherEntrypoint, PayloadId, PayloadStatus, SubmitterError,
};

use crate::msg::pending_message::CONFIRM_DELAY;
use crate::server::MessageRetryRequest;

use super::op_batch::OperationBatch;
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
pub struct SerialSubmitter {
    /// Domain this submitter delivers to.
    domain: HyperlaneDomain,
    /// Receiver for new messages to submit.
    rx: Option<mpsc::UnboundedReceiver<QueueOperation>>,
    /// Metrics for serial submitter.
    metrics: SerialSubmitterMetrics,
    /// Max batch size for submitting messages
    max_batch_size: u32,
    max_submit_queue_len: Option<u32>,
    /// tokio task monitor
    task_monitor: TaskMonitor,
    prepare_queue: OpQueue,
    submit_queue: OpQueue,
    confirm_queue: OpQueue,
    payload_dispatcher_entrypoint: Option<PayloadDispatcherEntrypoint>,
    db: Arc<dyn HyperlaneDb>,
}

impl SerialSubmitter {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        domain: HyperlaneDomain,
        rx: mpsc::UnboundedReceiver<QueueOperation>,
        retry_op_transmitter: &Sender<MessageRetryRequest>,
        metrics: SerialSubmitterMetrics,
        max_batch_size: u32,
        max_submit_queue_len: Option<u32>,
        task_monitor: TaskMonitor,
        payload_dispatcher_entrypoint: Option<PayloadDispatcherEntrypoint>,
        db: HyperlaneRocksDB,
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
            // Using Options so that method which needs it can take from struct
            rx: Some(rx),
            metrics,
            max_batch_size,
            max_submit_queue_len,
            task_monitor,
            prepare_queue,
            submit_queue,
            confirm_queue,
            payload_dispatcher_entrypoint,
            db: Arc::new(db),
        }
    }

    pub async fn prepare_queue(&self) -> OperationPriorityQueue {
        self.prepare_queue.queue.clone()
    }

    pub fn spawn(self) -> JoinHandle<()> {
        let span = info_span!("SerialSubmitter", destination=%self.domain);
        let task_monitor = self.task_monitor.clone();
        let name = Self::task_name("", &self.domain);
        tokio::task::Builder::new()
            .name(&name)
            .spawn(TaskMonitor::instrument(
                &task_monitor,
                async move { self.run().await }.instrument(span),
            ))
            .expect("spawning tokio task from Builder is infallible")
    }

    async fn run(mut self) {
        let rx_prepare = self.rx.take().expect("rx should be initialised");

        let entrypoint = self.payload_dispatcher_entrypoint.take().map(Arc::new);

        let prepare_task = match &entrypoint {
            None => self.create_classic_prepare_task(),
            Some(entrypoint) => self.create_lander_prepare_task(entrypoint.clone()),
        };

        let submit_task = match &entrypoint {
            None => self.create_classic_submit_task(),
            Some(entrypoint) => self.create_lander_submit_task(entrypoint.clone()),
        };

        let confirm_task = match &entrypoint {
            None => self.create_classic_confirm_task(),
            Some(entrypoint) => self.create_lander_confirm_task(entrypoint.clone()),
        };

        let tasks = [
            self.create_receive_task(rx_prepare),
            prepare_task,
            submit_task,
            confirm_task,
        ];

        if let Err(err) = try_join_all(tasks).await {
            error!(
                error=?err,
                domain=?self.domain,
                "SerialSubmitter task panicked for domain"
            );
        }
    }

    fn create_receive_task(
        &self,
        rx_prepare: mpsc::UnboundedReceiver<QueueOperation>,
    ) -> JoinHandle<()> {
        let name = Self::task_name("receive::", &self.domain);
        tokio::task::Builder::new()
            .name(&name)
            .spawn(TaskMonitor::instrument(
                &self.task_monitor,
                receive_task(self.domain.clone(), rx_prepare, self.prepare_queue.clone()),
            ))
            .expect("spawning tokio task from Builder is infallible")
    }

    fn create_classic_prepare_task(&self) -> JoinHandle<()> {
        let name = Self::task_name("prepare_classic::", &self.domain);
        tokio::task::Builder::new()
            .name(&name)
            .spawn(TaskMonitor::instrument(
                &self.task_monitor,
                prepare_classic_task(
                    self.domain.clone(),
                    self.prepare_queue.clone(),
                    self.submit_queue.clone(),
                    self.confirm_queue.clone(),
                    self.max_batch_size,
                    self.max_submit_queue_len,
                    self.metrics.clone(),
                ),
            ))
            .expect("spawning tokio task from Builder is infallible")
    }

    fn create_classic_submit_task(&self) -> JoinHandle<()> {
        let name = Self::task_name("submit_classic::", &self.domain);
        tokio::task::Builder::new()
            .name(&name)
            .spawn(TaskMonitor::instrument(
                &self.task_monitor,
                submit_classic_task(
                    self.domain.clone(),
                    self.prepare_queue.clone(),
                    self.submit_queue.clone(),
                    self.confirm_queue.clone(),
                    self.max_batch_size,
                    self.metrics.clone(),
                ),
            ))
            .expect("spawning tokio task from Builder is infallible")
    }

    fn create_classic_confirm_task(&self) -> JoinHandle<()> {
        let name = Self::task_name("confirm_classic::", &self.domain);
        tokio::task::Builder::new()
            .name(&name)
            .spawn(TaskMonitor::instrument(
                &self.task_monitor,
                confirm_classic_task(
                    self.domain.clone(),
                    self.prepare_queue.clone(),
                    self.confirm_queue.clone(),
                    self.max_batch_size,
                    self.metrics.clone(),
                ),
            ))
            .expect("spawning tokio task from Builder is infallible")
    }

    fn create_lander_prepare_task(
        &self,
        entrypoint: Arc<PayloadDispatcherEntrypoint>,
    ) -> JoinHandle<()> {
        let name = Self::task_name("prepare_lander::", &self.domain);
        tokio::task::Builder::new()
            .name(&name)
            .spawn(TaskMonitor::instrument(
                &self.task_monitor,
                prepare_lander_task(
                    entrypoint,
                    self.domain.clone(),
                    self.prepare_queue.clone(),
                    self.submit_queue.clone(),
                    self.confirm_queue.clone(),
                    self.max_batch_size,
                    self.max_submit_queue_len,
                    self.metrics.clone(),
                    self.db.clone(),
                ),
            ))
            .expect("spawning tokio task from Builder is infallible")
    }

    fn create_lander_submit_task(
        &self,
        entrypoint: Arc<PayloadDispatcherEntrypoint>,
    ) -> JoinHandle<()> {
        let name = Self::task_name("submit_lander::", &self.domain);
        tokio::task::Builder::new()
            .name(&name)
            .spawn(TaskMonitor::instrument(
                &self.task_monitor,
                submit_lander_task(
                    entrypoint,
                    self.domain.clone(),
                    self.prepare_queue.clone(),
                    self.submit_queue.clone(),
                    self.confirm_queue.clone(),
                    self.max_batch_size,
                    self.metrics.clone(),
                    self.db.clone(),
                ),
            ))
            .expect("spawning tokio task from Builder is infallible")
    }

    fn create_lander_confirm_task(
        &self,
        entrypoint: Arc<PayloadDispatcherEntrypoint>,
    ) -> JoinHandle<()> {
        let name = Self::task_name("confirm_lander::", &self.domain);
        tokio::task::Builder::new()
            .name(&name)
            .spawn(TaskMonitor::instrument(
                &self.task_monitor,
                confirm_lander_task(
                    entrypoint,
                    self.domain.clone(),
                    self.prepare_queue.clone(),
                    self.confirm_queue.clone(),
                    self.max_batch_size,
                    self.metrics.clone(),
                    self.db.clone(),
                ),
            ))
            .expect("spawning tokio task from Builder is infallible")
    }

    fn task_name(prefix: &str, domain: &HyperlaneDomain) -> String {
        format!("op_submitter::{}{}", prefix, domain.name())
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
async fn prepare_classic_task(
    domain: HyperlaneDomain,
    mut prepare_queue: OpQueue,
    submit_queue: OpQueue,
    confirm_queue: OpQueue,
    max_batch_size: u32,
    max_submit_queue_len: Option<u32>,
    metrics: SerialSubmitterMetrics,
) {
    loop {
        if apply_backpressure(&submit_queue, &max_submit_queue_len).await {
            // The submit queue is too long, so give some time before checking again
            sleep(Duration::from_millis(150)).await;
            continue;
        }

        let Some(batch) = get_batch_or_wait(&mut prepare_queue, max_batch_size).await else {
            continue;
        };

        process_batch(
            domain.clone(),
            batch,
            &mut prepare_queue,
            &submit_queue,
            &confirm_queue,
            &metrics,
        )
        .await;
    }
}

#[instrument(skip_all, fields(%domain))]
#[allow(clippy::too_many_arguments)]
async fn prepare_lander_task(
    entrypoint: Arc<PayloadDispatcherEntrypoint>,
    domain: HyperlaneDomain,
    mut prepare_queue: OpQueue,
    submit_queue: OpQueue,
    confirm_queue: OpQueue,
    max_batch_size: u32,
    max_submit_queue_len: Option<u32>,
    metrics: SerialSubmitterMetrics,
    db: Arc<dyn HyperlaneDb>,
) {
    loop {
        if apply_backpressure(&submit_queue, &max_submit_queue_len).await {
            // The submit queue is too long, so give some time before checking again
            sleep(Duration::from_millis(150)).await;
            continue;
        }

        let Some(batch) = get_batch_or_wait(&mut prepare_queue, max_batch_size).await else {
            continue;
        };

        let batch_to_process = confirm_already_submitted_operations(
            entrypoint.clone(),
            &confirm_queue,
            db.clone(),
            batch,
        )
        .await;

        process_batch(
            domain.clone(),
            batch_to_process,
            &mut prepare_queue,
            &submit_queue,
            &confirm_queue,
            &metrics,
        )
        .await;
    }
}

/// This function checks the status of the payloads associated with the operations in the batch.
/// If the payload is not dropped, the operation is pushed to the confirmation queue.
/// If the payload is dropped, does not exist or there is issue in retrieving payload or its status, the operation will go through prepare logic.
async fn confirm_already_submitted_operations(
    entrypoint: Arc<PayloadDispatcherEntrypoint>,
    confirm_queue: &OpQueue,
    db: Arc<dyn HyperlaneDb>,
    batch: Vec<QueueOperation>,
) -> Vec<QueueOperation> {
    use ConfirmReason::AlreadySubmitted;
    use PendingOperationStatus::Confirm;

    let mut ops_to_prepare = vec![];
    for op in batch.into_iter() {
        if has_operation_been_submitted(entrypoint.clone(), db.clone(), &op).await {
            let status = Some(Confirm(AlreadySubmitted));
            confirm_queue.push(op, status).await;
        } else {
            ops_to_prepare.push(op);
        }
    }
    ops_to_prepare
}

async fn has_operation_been_submitted(
    entrypoint: Arc<PayloadDispatcherEntrypoint>,
    db: Arc<dyn HyperlaneDb>,
    op: &QueueOperation,
) -> bool {
    let id = op.id();

    let payload_ids = match db.retrieve_payload_ids_by_message_id(&id) {
        Ok(ids) => ids,
        Err(_) => return false,
    };

    let payload_ids = match payload_ids {
        None => return false,
        Some(ids) if ids.is_empty() => return false,
        Some(ids) => ids,
    };

    // TODO checking only the first payload id since we support a single payload per message at this point
    let payload_id = payload_ids[0].clone();
    let status = entrypoint.payload_status(payload_id).await;

    match status {
        Ok(PayloadStatus::Dropped(_)) => false,
        Ok(_) => true,
        Err(_) => false,
    }
}

/// Applies backpressure to the prepare queue if the submit queue is too long.
async fn apply_backpressure(submit_queue: &OpQueue, max_len: &Option<u32>) -> bool {
    if let Some(max_len) = max_len {
        let submit_queue_len = submit_queue.len().await as u32;
        if submit_queue_len >= *max_len {
            debug!(
                %submit_queue_len,
                max_submit_queue_len=%max_len,
                "Submit queue is too long, waiting to prepare more ops"
            );
            return true;
        }
    }
    false
}

/// Helper method to get a batch from the queue or wait if the queue is empty.
async fn get_batch_or_wait(queue: &mut OpQueue, batch_size: u32) -> Option<Vec<QueueOperation>> {
    let batch = queue.pop_many(batch_size as usize).await;
    if batch.is_empty() {
        // Queue is empty, wait before retrying to prevent burning CPU.
        sleep(Duration::from_millis(100)).await;
        None
    } else {
        Some(batch)
    }
}

async fn process_batch(
    domain: HyperlaneDomain,
    mut batch: Vec<QueueOperation>,
    prepare_queue: &mut OpQueue,
    submit_queue: &OpQueue,
    confirm_queue: &OpQueue,
    metrics: &SerialSubmitterMetrics,
) {
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

#[instrument(skip_all, fields(%domain))]
async fn submit_classic_task(
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

#[allow(clippy::too_many_arguments)]
#[instrument(skip_all, fields(domain=%_domain))]
async fn submit_lander_task(
    entrypoint: Arc<PayloadDispatcherEntrypoint>,
    _domain: HyperlaneDomain, // used for instrumentation only
    prepare_queue: OpQueue,
    mut submit_queue: OpQueue,
    confirm_queue: OpQueue,
    max_batch_size: u32,
    metrics: SerialSubmitterMetrics,
    db: Arc<dyn HyperlaneDb>,
) {
    let recv_limit = max_batch_size as usize;
    loop {
        let batch = submit_queue.pop_many(recv_limit).await;
        for op in batch.into_iter() {
            submit_via_lander(
                op,
                &entrypoint,
                &prepare_queue,
                &confirm_queue,
                &metrics,
                db.clone(),
            )
            .await;
        }
    }
}

async fn submit_via_lander(
    op: QueueOperation,
    entrypoint: &Arc<PayloadDispatcherEntrypoint>,
    prepare_queue: &OpQueue,
    confirm_queue: &OpQueue,
    metrics: &SerialSubmitterMetrics,
    db: Arc<dyn HyperlaneDb>,
) {
    let operation_payload = match op.payload().await {
        Ok(p) => p,
        Err(e) => {
            let reason = ReprepareReason::ErrorCreatingPayload;
            let msg = "Error creating payload";
            prepare_op(op, prepare_queue, e, msg, reason).await;
            return;
        }
    };

    let operation_success_criteria = match op.success_criteria() {
        Ok(s) => s,
        Err(e) => {
            let reason = ReprepareReason::ErrorCreatingPayloadSuccessCriteria;
            let msg = "Error creating payload success criteria";
            prepare_op(op, prepare_queue, e, msg, reason).await;
            return;
        }
    };

    let message_id = op.id();
    let metadata = format!("{message_id:?}");
    let mailbox = op
        .try_get_mailbox()
        .expect("Operation should contain Mailbox address")
        .address();
    let payload_id = PayloadId::random();
    let payload = FullPayload::new(
        payload_id,
        metadata,
        operation_payload,
        operation_success_criteria,
        mailbox,
    );

    if let Err(e) = entrypoint.send_payload(&payload).await {
        let reason = ReprepareReason::ErrorSubmitting;
        let msg = "Error sending payload";
        prepare_op(op, prepare_queue, e, msg, reason).await;
        return;
    }

    if let Err(e) = db.store_payload_ids_by_message_id(&message_id, vec![payload.details.id]) {
        let reason = ReprepareReason::ErrorStoringPayloadIdsByMessageId;
        let msg = "Error storing mapping from message id to payload ids";
        prepare_op(op, prepare_queue, e, msg, reason).await;
        return;
    }

    confirm_op(op, confirm_queue, metrics).await;
}

async fn prepare_op(
    mut op: QueueOperation,
    prepare_queue: &OpQueue,
    err: impl Debug,
    msg: &str,
    reason: ReprepareReason,
) {
    use PendingOperationStatus::Retry;

    let status = Retry(reason.clone());
    let result = op.on_reprepare(Some(format!("{:?}", err)), reason);
    warn!(?err, ?status, ?result, msg);
    prepare_queue.push(op, Some(status)).await;
}

#[instrument(skip(prepare_queue, confirm_queue, metrics), ret, level = "debug")]
pub(crate) async fn submit_single_operation(
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
    confirm_queue: &OpQueue,
    metrics: &SerialSubmitterMetrics,
) {
    use ConfirmReason::SubmittedBySelf;

    let destination = op.destination_domain().clone();
    debug!(?op, "Operation submitted");
    op.set_next_attempt_after(CONFIRM_DELAY);
    confirm_queue
        .push(op, Some(PendingOperationStatus::Confirm(SubmittedBySelf)))
        .await;
    metrics.ops_submitted.inc();

    if matches!(
        destination.domain_protocol(),
        HyperlaneDomainProtocol::Cosmos | HyperlaneDomainProtocol::CosmosNative
    ) {
        // On cosmos chains, sleep for 1 sec (the finality period).
        // Otherwise we get `account sequence mismatch` errors, which have caused us
        // to lose liveness.
        sleep(Duration::from_secs(1)).await;
    }
}

#[instrument(skip_all, fields(%domain))]
async fn confirm_classic_task(
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
        if op_results.iter().all(|op_result| {
            matches!(
                op_result,
                PendingOperationResult::NotReady | PendingOperationResult::Confirm(_)
            )
        }) {
            // None of the operations are ready, so wait for a little bit
            // before checking again to prevent burning CPU
            sleep(Duration::from_millis(500)).await;
        }
    }
}

#[instrument(skip_all, fields(%domain))]
async fn confirm_lander_task(
    entrypoint: Arc<PayloadDispatcherEntrypoint>,
    domain: HyperlaneDomain,
    prepare_queue: OpQueue,
    mut confirm_queue: OpQueue,
    max_batch_size: u32,
    metrics: SerialSubmitterMetrics,
    db: Arc<dyn HyperlaneDb>,
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
        // cannot use `join_all` here because db reads are blocking
        let payload_id_results = batch
            .into_iter()
            .map(|op| {
                let message_id = op.id();
                (op, db.retrieve_payload_ids_by_message_id(&message_id))
            })
            .collect::<Vec<_>>();

        let payload_status_result_futures = payload_id_results
            .into_iter()
            .map(|(op, result)| async {
                let message_id = op.id();
                match result {
                    Ok(Some(ids)) if !ids.is_empty() => {
                        let op_futures = ids
                            .into_iter()
                            .map(|id| async {
                                let status = entrypoint.payload_status(id.clone()).await;
                                (id, status)
                            })
                            .collect::<Vec<_>>();
                        let op_results = join_all(op_futures).await;
                        Some((op, op_results))
                    }
                    Ok(Some(_)) | Ok(None) | Err(_) => {
                        debug!(?op, ?message_id, "No payload id found for message id",);
                        send_back_on_failed_submission(
                            op,
                            prepare_queue.clone(),
                            &metrics,
                            Some(&ReprepareReason::ErrorRetrievingPayloadIds),
                        )
                        .await;
                        None
                    }
                }
            })
            .collect::<Vec<_>>();

        let payload_status_results = join_all(payload_status_result_futures)
            .await
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();

        let confirmed_operations = Arc::new(Mutex::new(0));
        let confirm_futures = payload_status_results
            .into_iter()
            .map(|(op, status_results)| async {
                let status_results_len = status_results.len();
                let successes = filter_status_results(status_results);

                if status_results_len - successes.len() > 0 {
                    warn!(?op, "Error retrieving payload status",);
                    send_back_on_failed_submission(
                        op,
                        prepare_queue.clone(),
                        &metrics,
                        Some(&ReprepareReason::ErrorRetrievingPayloadStatus),
                    )
                    .await;
                    return;
                }

                let finalized = !successes.iter().any(|(_, status)| !status.is_finalized());

                if finalized {
                    {
                        let mut lock = confirmed_operations.lock().await;
                        *lock += 1;
                    }
                    confirm_operation(
                        op,
                        domain.clone(),
                        prepare_queue.clone(),
                        confirm_queue.clone(),
                        metrics.clone(),
                    )
                    .await;
                } else {
                    info!(?op, ?successes, "Operation not finalized yet");
                    process_confirm_result(
                        op,
                        prepare_queue.clone(),
                        confirm_queue.clone(),
                        metrics.clone(),
                        PendingOperationResult::Confirm(ConfirmReason::SubmittedBySelf),
                    )
                    .await;
                }
            })
            .collect::<Vec<_>>();
        let _ = join_all(confirm_futures).await;
        if confirmed_operations.lock().await.is_zero() {
            // None of the operations are ready, so wait for a little bit
            // before checking again to prevent burning CPU
            sleep(Duration::from_millis(500)).await;
        }
    }
}

fn filter_status_results(
    status_results: Vec<(PayloadId, Result<PayloadStatus, SubmitterError>)>,
) -> Vec<(PayloadId, PayloadStatus)> {
    status_results
        .into_iter()
        .filter_map(|(id, result)| Some((id, result.ok()?)))
        .collect::<Vec<_>>()
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
    process_confirm_result(op, prepare_queue, confirm_queue, metrics, operation_result).await
}

async fn process_confirm_result(
    op: QueueOperation,
    prepare_queue: OpQueue,
    confirm_queue: OpQueue,
    metrics: SerialSubmitterMetrics,
    operation_result: PendingOperationResult,
) -> PendingOperationResult {
    match &operation_result {
        PendingOperationResult::Success => {
            debug!(id=?op.id(), ?op, "Operation confirmed");
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
            send_back_on_failed_submission(op, prepare_queue.clone(), &metrics, Some(reason)).await;
        }
        PendingOperationResult::Drop => {
            metrics.ops_dropped.inc();
            op.decrement_metric_if_exists();
        }
    }
    operation_result
}

async fn send_back_on_failed_submission(
    op: QueueOperation,
    prepare_queue: OpQueue,
    metrics: &SerialSubmitterMetrics,
    maybe_reason: Option<&ReprepareReason>,
) {
    metrics.ops_failed.inc();
    let reason = maybe_reason.unwrap_or(&ReprepareReason::ErrorSubmitting);
    prepare_queue
        .push(op, Some(PendingOperationStatus::Retry(reason.clone())))
        .await;
}

#[derive(Debug, Clone)]
pub struct SerialSubmitterMetrics {
    pub(crate) submitter_queue_length: IntGaugeVec,
    pub(crate) ops_prepared: IntCounter,
    pub(crate) ops_submitted: IntCounter,
    pub(crate) ops_confirmed: IntCounter,
    pub(crate) ops_failed: IntCounter,
    pub(crate) ops_dropped: IntCounter,
}

impl SerialSubmitterMetrics {
    pub fn new(metrics: impl AsRef<CoreMetrics>, destination: &HyperlaneDomain) -> Self {
        let destination = destination.name();
        Self {
            submitter_queue_length: metrics.as_ref().submitter_queue_length(),
            ops_prepared: metrics
                .as_ref()
                .operations_processed_count()
                .with_label_values(&["prepared", destination]),
            ops_submitted: metrics
                .as_ref()
                .operations_processed_count()
                .with_label_values(&["submitted", destination]),
            ops_confirmed: metrics
                .as_ref()
                .operations_processed_count()
                .with_label_values(&["confirmed", destination]),
            ops_failed: metrics
                .as_ref()
                .operations_processed_count()
                .with_label_values(&["failed", destination]),
            ops_dropped: metrics
                .as_ref()
                .operations_processed_count()
                .with_label_values(&["dropped", destination]),
        }
    }
}
