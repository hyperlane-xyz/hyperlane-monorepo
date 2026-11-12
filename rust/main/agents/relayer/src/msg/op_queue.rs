use std::{
    cmp::Reverse,
    collections::BinaryHeap,
    sync::Arc,
    time::{Duration, Instant},
};

use derive_new::new;
use hyperlane_core::{PendingOperation, PendingOperationStatus, QueueOperation, ReprepareReason};
use prometheus::{IntGauge, IntGaugeVec};
use tokio::{
    sync::{
        broadcast::{error::RecvError, Receiver},
        Mutex, Notify,
    },
    time::sleep_until,
};
use tracing::{instrument, trace};

use super::runtime_denylist::RuntimeDenylist;
use crate::server::operations::message_retry::{MessageRetryQueueResponse, MessageRetryRequest};
use crate::settings::matching_list::MatchingListExt;

/// Fully-denied batches examined per `pop_many_ready` before returning, so
/// a long denied backlog can't defer retry requests.
const EVICTION_ROUNDS_PER_POP: usize = 16;

pub type OperationPriorityQueue = Arc<Mutex<BinaryHeap<Reverse<QueueOperation>>>>;

/// Queue of generic operations that can be submitted to a destination chain.
/// Includes logic for maintaining queue metrics by the destination and `app_context` of an operation
#[derive(Debug, Clone, new)]
pub struct OpQueue {
    metrics: IntGaugeVec,
    queue_metrics_label: String,
    retry_receiver: Arc<Mutex<Receiver<MessageRetryRequest>>>,
    #[new(default)]
    notify: Arc<Notify>,
    #[new(default)]
    space_available: Arc<Notify>,
    #[new(default)]
    pub queue: OperationPriorityQueue,
    /// Operations matching this are dropped when popped.
    #[new(default)]
    denylist: Arc<RuntimeDenylist>,
    #[new(default)]
    last_recovery_sweep: Arc<Mutex<Option<Instant>>>,
}

impl OpQueue {
    /// Drop popped operations that match `denylist`.
    pub fn with_runtime_denylist(mut self, denylist: Arc<RuntimeDenylist>) -> Self {
        self.denylist = denylist;
        self
    }

    /// Remove denied operations from a popped batch. Dropping an operation
    /// releases its loaded-message guard; the DB loader skips it while the
    /// rule stays active and reloads it after the rule is removed.
    async fn evict_denied(&self, popped: Vec<QueueOperation>) -> Vec<QueueOperation> {
        let mut kept = Vec::with_capacity(popped.len());
        for mut op in popped {
            let Some(reason) = self.denylist.deny_reason_for_queued_op(op.as_ref()).await else {
                kept.push(op);
                continue;
            };
            tracing::warn!(
                id = ?op.id(),
                queue = %self.queue_metrics_label,
                %reason,
                "Dropping operation matching runtime denylist"
            );
            op.on_runtime_denylist_drop();
            op.decrement_metric_if_exists();
            self.denylist
                .record_eviction(op.destination_domain().name(), &self.queue_metrics_label);
        }
        kept
    }

    // Release stale loaded-message guards and queue capacity even when an old
    // operation has a long retry deadline. Receipts already being confirmed stay.
    async fn sweep_invalidated(&self) {
        let mut last = self.last_recovery_sweep.lock().await;
        if last.is_some_and(|last| last.elapsed() < Duration::from_secs(5)) {
            return;
        }
        *last = Some(Instant::now());
        let mut queue = self.queue.lock().await;
        let before = queue.len();
        queue.retain(|Reverse(op)| {
            if op.is_invalidated() {
                op.decrement_metric_if_exists();
                false
            } else {
                true
            }
        });
        if queue.len() != before {
            self.space_available.notify_waiters();
        }
    }

    /// Push an element onto the queue and update metrics
    /// Arguments:
    /// - `op`: the operation to push onto the queue
    /// - `new_status`: optional new status to set for the operation. When an operation is added to a queue,
    /// it's very likely that its status has just changed, so this forces the caller to consider the new status
    #[instrument(skip(self), ret, fields(queue_label=%self.queue_metrics_label), level = "trace")]
    pub async fn push(&self, mut op: QueueOperation, new_status: Option<PendingOperationStatus>) {
        let new_metric = Arc::new(self.get_new_operation_metric(op.as_ref(), new_status.clone()));
        op.set_status_and_update_metrics(new_status, new_metric);

        self.queue.lock().await.push(Reverse(op));
        self.notify.notify_one();
    }

    /// Pop an element from the queue and update metrics
    #[allow(dead_code)] // only used in tests
    #[instrument(skip(self), ret, fields(queue_label=%self.queue_metrics_label), level = "trace")]
    pub async fn pop(&mut self) -> Option<QueueOperation> {
        let pop_attempt = self.pop_many(1).await;
        pop_attempt.into_iter().next()
    }

    /// Pop multiple elements at once from the queue and update metrics
    #[instrument(skip(self), fields(queue_label=%self.queue_metrics_label), level = "debug")]
    pub async fn pop_many(&mut self, limit: usize) -> Vec<QueueOperation> {
        self.process_retry_requests().await;
        let mut queue = self.queue.lock().await;
        let mut popped = vec![];
        while let Some(Reverse(op)) = queue.pop() {
            popped.push(op);
            if popped.len() >= limit {
                break;
            }
        }
        drop(queue);
        if !popped.is_empty() {
            self.space_available.notify_one();
        }
        let popped = self.evict_denied(popped).await;

        // This function is called very often by the message processor tasks, so only log when there are operations to pop
        // to avoid spamming the logs
        if !popped.is_empty() {
            trace!(
                queue_label = %self.queue_metrics_label,
                operations = ?popped,
                "Popped OpQueue operations"
            );
        }
        popped
    }

    pub async fn pop_many_ready(&mut self, limit: usize) -> (Vec<QueueOperation>, Option<Instant>) {
        self.process_retry_requests().await;
        for _ in 0..EVICTION_ROUNDS_PER_POP {
            let (popped, next_deadline) = self.pop_ready(limit).await;
            if popped.is_empty() {
                return (popped, next_deadline);
            }
            let kept = self.evict_denied(popped).await;
            // If every popped operation was denied, look again rather than
            // making the caller wait for a push while ready work remains.
            if !kept.is_empty() {
                return (kept, next_deadline);
            }
        }
        // A long run of denied ops: hand back an immediate deadline so the
        // caller polls again (servicing retry requests) instead of sleeping.
        (vec![], Some(Instant::now()))
    }

    async fn pop_ready(&self, limit: usize) -> (Vec<QueueOperation>, Option<Instant>) {
        self.sweep_invalidated().await;
        let now = Instant::now();
        let mut queue = self.queue.lock().await;
        let mut popped = Vec::with_capacity(limit.min(queue.len()));
        while popped.len() < limit {
            let Some(Reverse(next)) = queue.peek() else {
                break;
            };
            if next
                .next_attempt_after()
                .is_some_and(|deadline| deadline > now)
            {
                break;
            }
            if let Some(Reverse(op)) = queue.pop() {
                popped.push(op);
            }
        }
        let next_deadline = queue
            .peek()
            .and_then(|Reverse(operation)| operation.next_attempt_after());
        drop(queue);
        if !popped.is_empty() {
            self.space_available.notify_one();
        }
        (popped, next_deadline)
    }

    pub async fn wait_for_len_below(&self, limit: usize) {
        loop {
            let notified = self.space_available.notified();
            self.sweep_invalidated().await;
            if self.len().await < limit {
                return;
            }
            let _ = tokio::time::timeout(Duration::from_secs(5), notified).await;
        }
    }

    pub async fn wait_for_ready(&mut self, deadline: Option<Instant>) {
        let notify = self.notify.clone();
        let retry_receiver = self.retry_receiver.clone();
        let retry_request = async move {
            let result = {
                let mut receiver = retry_receiver.lock().await;
                receiver.recv().await
            };
            match result {
                Ok(request) => Some(request),
                Err(RecvError::Lagged(_)) => None,
                Err(RecvError::Closed) => std::future::pending().await,
            }
        };

        let recovery_check = Instant::now()
            .checked_add(Duration::from_secs(5))
            .expect("Recovery deadline fits in Instant");
        let deadline = deadline.map_or(recovery_check, |deadline| deadline.min(recovery_check));
        let retry_request = tokio::select! {
            _ = notify.notified() => None,
            _ = sleep_until(deadline.into()) => None,
            request = retry_request => request,
        };
        if let Some(retry_request) = retry_request {
            self.process_retry_request_batch(vec![retry_request]).await;
        }
    }

    pub async fn process_retry_requests(&mut self) {
        // TODO: could rate-limit ourselves here, but we expect the volume of messages over this channel to
        // be very low.
        // The other consideration is whether to put the channel receiver in the OpQueue or in a dedicated task
        // that also holds an Arc to the Mutex. For simplicity, we'll put it in the OpQueue for now.
        let mut message_retry_requests = vec![];
        {
            let mut retry_receiver = self.retry_receiver.lock().await;
            while let Ok(retry_request) = retry_receiver.try_recv() {
                message_retry_requests.push(retry_request);
            }
        }
        if message_retry_requests.is_empty() {
            return;
        }

        self.process_retry_request_batch(message_retry_requests)
            .await;
    }

    async fn process_retry_request_batch(
        &mut self,
        message_retry_requests: Vec<MessageRetryRequest>,
    ) {
        let (retry_responses, queue_length) = {
            let mut queue = self.queue.lock().await;
            let responses = Self::reprioritize_matching(&mut queue, &message_retry_requests);
            (responses, queue.len())
        };

        for (retry_req, mut retry_response) in message_retry_requests
            .into_iter()
            .zip(retry_responses.into_iter())
        {
            retry_response.evaluated = queue_length;
            tracing::debug!(
                uuid = retry_req.uuid,
                evaluated = retry_response.evaluated,
                matched = retry_response.matched,
                "Sending relayer retry response back"
            );
            if let Err(err) = retry_req.transmitter.send(retry_response).await {
                tracing::error!(?err, "Failed to send retry response");
            }
        }
    }

    /// Get the metric associated with this operation
    fn get_new_operation_metric(
        &self,
        operation: &dyn PendingOperation,
        new_status: Option<PendingOperationStatus>,
    ) -> IntGauge {
        let (destination, app_context) = operation.get_operation_labels();
        let new_metric_status = new_status.unwrap_or(operation.status());
        self.metrics.with_label_values(&[
            &destination,
            &self.queue_metrics_label,
            &new_metric_status.to_string(),
            &app_context,
        ])
    }

    fn reprioritize_matching(
        queue: &mut BinaryHeap<Reverse<Box<dyn PendingOperation>>>,
        retry_requests: &[MessageRetryRequest],
    ) -> Vec<MessageRetryQueueResponse> {
        let mut retry_responses: Vec<_> = (0..retry_requests.len())
            .map(|_| MessageRetryQueueResponse::default())
            .collect();
        let mut reprioritized_queue: BinaryHeap<_> = queue
            .drain()
            .map(|Reverse(mut op)| {
                let mut matched = false;
                let matching_requests = retry_responses
                    .iter()
                    .enumerate()
                    .filter_map(|(i, _)| {
                        let retry_req = &retry_requests[i];
                        if !retry_req.pattern.op_matches(&op) {
                            return None;
                        }
                        matched = true;
                        Some(i)
                    })
                    .collect::<Vec<_>>();
                if matched {
                    let reset_succeeded = op.reset_attempts();
                    if reset_succeeded {
                        op.set_status(PendingOperationStatus::Retry(ReprepareReason::Manual));
                    }
                    for i in matching_requests {
                        let retry_response = &mut retry_responses[i];
                        if reset_succeeded {
                            retry_response.matched = retry_response.matched.saturating_add(1);
                        } else {
                            retry_response.failed = retry_response.failed.saturating_add(1);
                        }
                    }
                }
                Reverse(op)
            })
            .collect();
        queue.append(&mut reprioritized_queue);
        retry_responses
    }

    pub async fn len(&self) -> usize {
        let queue = self.queue.lock().await;
        queue.len()
    }
}

#[cfg(test)]
pub mod tests;
