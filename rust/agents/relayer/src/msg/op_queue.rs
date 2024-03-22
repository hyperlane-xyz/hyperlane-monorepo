use std::{cmp::Reverse, collections::BinaryHeap, sync::Arc};

use derive_new::new;
use hyperlane_core::{MpmcReceiver, H256};
use prometheus::{IntGauge, IntGaugeVec};
use tokio::sync::Mutex;

use super::pending_operation::PendingOperation;

pub type QueueOperation = Box<dyn PendingOperation>;

/// Queue of generic operations that can be submitted to a destination chain.
/// Includes logic for maintaining queue metrics by the destination and `app_context` of an operation
#[derive(Debug, Clone, new)]
pub struct OpQueue {
    metrics: IntGaugeVec,
    queue_metrics_label: String,
    retry_rx: MpmcReceiver<H256>,
    #[new(default)]
    queue: Arc<Mutex<BinaryHeap<Reverse<QueueOperation>>>>,
}

impl OpQueue {
    /// Push an element onto the queue and update metrics
    pub async fn push(&self, op: QueueOperation) {
        // increment the metric before pushing onto the queue, because we lose ownership afterwards
        self.get_operation_metric(op.as_ref()).inc();

        self.queue.lock().await.push(Reverse(op));
    }

    /// Pop an element from the queue and update metrics
    pub async fn pop(&mut self) -> Option<Reverse<QueueOperation>> {
        self.process_retry_requests().await;
        let op = self.queue.lock().await.pop();
        op.map(|op| {
            // even if the metric is decremented here, the operation may fail to process and be re-added to the queue.
            // in those cases, the queue length will decrease to zero until the operation is re-added.
            self.get_operation_metric(op.0.as_ref()).dec();
            op
        })
    }

    pub async fn process_retry_requests(&mut self) {
        // TODO: could rate-limit ourselves here, but we expect the volume of messages over this channel to
        // be very low.
        // The other consideration is whether to put the channel receiver in the OpQueue or in a dedicated task
        // that also holds an Arc to the Mutex. For simplicity, we'll put it in the OpQueue for now.
        let mut message_ids = vec![];
        while let Ok(message_id) = self.retry_rx.receiver.try_recv() {
            message_ids.push(message_id);
        }
        if message_ids.is_empty() {
            return;
        }
        let mut queue = self.queue.lock().await;
        let mut repriotized_queue: BinaryHeap<_> = queue
            .drain()
            .map(|Reverse(mut e)| {
                if message_ids.contains(&e.id()) {
                    e.reset_attempts()
                }
                Reverse(e)
            })
            .collect();
        queue.append(&mut repriotized_queue);
    }

    /// Get the metric associated with this operation
    fn get_operation_metric(&self, operation: &dyn PendingOperation) -> IntGauge {
        let (destination, app_context) = operation.get_operation_labels();
        self.metrics
            .with_label_values(&[&destination, &self.queue_metrics_label, &app_context])
    }
}

#[cfg(test)]
mod test {
    use std::time::{Duration, Instant};

    use hyperlane_core::{HyperlaneDomain, MpmcChannel};

    use crate::msg::pending_operation::PendingOperationResult;

    #[derive(Debug)]
    struct MockPendingOperation {
        id: H256,
        seconds_to_next_attempt: u64,
    }

    impl MockPendingOperation {
        fn new(seconds_to_next_attempt: u64) -> Self {
            Self {
                id: H256::random(),
                seconds_to_next_attempt,
            }
        }
    }

    #[async_trait::async_trait]
    impl PendingOperation for MockPendingOperation {
        fn id(&self) -> H256 {
            self.id
        }

        fn reset_attempts(&mut self) {
            self.seconds_to_next_attempt = 0;
        }

        fn priority(&self) -> u32 {
            todo!()
        }

        fn get_operation_labels(&self) -> (String, String) {
            Default::default()
        }

        fn origin_domain(&self) -> u32 {
            todo!()
        }

        fn destination_domain(&self) -> &HyperlaneDomain {
            todo!()
        }

        fn app_context(&self) -> Option<String> {
            todo!()
        }

        async fn prepare(&mut self) -> PendingOperationResult {
            todo!()
        }

        /// Submit this operation to the blockchain and report if it was successful
        /// or not.
        async fn submit(&mut self) -> PendingOperationResult {
            todo!()
        }

        /// This will be called after the operation has been submitted and is
        /// responsible for checking if the operation has reached a point at
        /// which we consider it safe from reorgs.
        async fn confirm(&mut self) -> PendingOperationResult {
            todo!()
        }

        fn next_attempt_after(&self) -> Option<Instant> {
            Some(
                Instant::now()
                    .checked_add(Duration::from_secs(self.seconds_to_next_attempt))
                    .unwrap(),
            )
        }

        fn set_retries(&mut self, _retries: u32) {
            todo!()
        }
    }

    use super::*;
    #[tokio::test]
    async fn test_op_queue() {
        // Create a new OpQueue
        let metrics = IntGaugeVec::new(
            prometheus::Opts::new("op_queue", "OpQueue metrics"),
            &["destination", "queue_metrics_label", "app_context"],
        )
        .unwrap();
        let queue_metrics_label = "queue_metrics_label".to_string();
        let mpmc_channel = MpmcChannel::new(100);
        let mut op_queue = OpQueue::new(metrics, queue_metrics_label, mpmc_channel.receiver());

        // Add some operations to the queue
        let op1 = Box::new(MockPendingOperation::new(1)) as QueueOperation;
        let op2 = Box::new(MockPendingOperation::new(2)) as QueueOperation;
        let op3 = Box::new(MockPendingOperation::new(3)) as QueueOperation;

        let op1_id = op1.id();
        let op2_id = op2.id();
        let op3_id = op3.id();
        op_queue.push(op1).await;
        op_queue.push(op2).await;
        op_queue.push(op3).await;

        // Send messages over the channel to retry some operations
        let mpmc_tx = mpmc_channel.sender();
        mpmc_tx.send(op2_id).unwrap();
        mpmc_tx.send(op3_id).unwrap();

        // Pop elements from the queue and verify the order
        let popped_op1 = op_queue.pop().await.unwrap();
        let popped_op2 = op_queue.pop().await.unwrap();
        let popped_op3 = op_queue.pop().await.unwrap();

        // The elements sent over the channel should be the first ones popped,
        // regardless of their initial `next_attempt_after`
        assert_eq!(popped_op1.0.id(), op3_id);
        assert_eq!(popped_op2.0.id(), op2_id);
        assert_eq!(popped_op3.0.id(), op1_id);
    }
}
