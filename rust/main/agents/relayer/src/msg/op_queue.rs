use std::{cmp::Reverse, collections::BinaryHeap, sync::Arc};

use derive_new::new;
use hyperlane_core::{PendingOperation, PendingOperationStatus, QueueOperation, ReprepareReason};
use prometheus::{IntGauge, IntGaugeVec};
use tokio::sync::{broadcast::Receiver, Mutex};
use tracing::{debug, instrument};

use crate::server::operations::message_retry::{MessageRetryQueueResponse, MessageRetryRequest};

pub type OperationPriorityQueue = Arc<Mutex<BinaryHeap<Reverse<QueueOperation>>>>;

/// Queue of generic operations that can be submitted to a destination chain.
/// Includes logic for maintaining queue metrics by the destination and `app_context` of an operation
#[derive(Debug, Clone, new)]
pub struct OpQueue {
    metrics: IntGaugeVec,
    queue_metrics_label: String,
    retry_receiver: Arc<Mutex<Receiver<MessageRetryRequest>>>,
    #[new(default)]
    pub queue: OperationPriorityQueue,
}

impl OpQueue {
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
    }

    /// Pop an element from the queue and update metrics
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

        // This function is called very often by the message processor tasks, so only log when there are operations to pop
        // to avoid spamming the logs
        if !popped.is_empty() {
            debug!(
                queue_label = %self.queue_metrics_label,
                operations = ?popped,
                "Popped OpQueue operations"
            );
        }
        popped
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
                retry_responses
                    .iter_mut()
                    .enumerate()
                    .for_each(|(i, retry_response)| {
                        let retry_req = &retry_requests[i];
                        if !retry_req.pattern.op_matches(&op) {
                            return;
                        }
                        // update retry metrics
                        retry_response.matched = retry_response.matched.saturating_add(1);
                        matched = true;
                    });
                if matched {
                    op.set_status(PendingOperationStatus::Retry(ReprepareReason::Manual));
                    op.reset_attempts();
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
