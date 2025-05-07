use std::{cmp::Reverse, collections::BinaryHeap, sync::Arc};

use derive_new::new;
use hyperlane_core::{PendingOperation, PendingOperationStatus, QueueOperation};
use prometheus::{IntGauge, IntGaugeVec};
use tokio::sync::{broadcast::Receiver, Mutex};
use tracing::{debug, instrument};

use crate::server::message_retry::{MessageRetryQueueResponse, MessageRetryRequest};

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
        // This function is called very often by the op_submitter tasks, so only log when there are operations to pop
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
                        retry_response.matched += 1;
                        matched = true;
                    });
                if matched {
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
pub mod test {
    use std::{
        collections::VecDeque,
        str::FromStr,
        time::{Duration, Instant},
    };

    use serde::Serialize;
    use tokio::sync::{self, mpsc};

    use hyperlane_core::{
        ChainResult, HyperlaneDomain, HyperlaneDomainProtocol, HyperlaneDomainTechnicalStack,
        HyperlaneDomainType, HyperlaneMessage, KnownHyperlaneDomain, Mailbox,
        PendingOperationResult, ReprepareReason, TryBatchAs, TxOutcome, H256, U256,
    };

    use crate::{
        server::ENDPOINT_MESSAGES_QUEUE_SIZE,
        settings::matching_list::{Filter, ListElement, MatchingList},
    };

    use super::*;

    #[derive(Debug, Clone, Serialize)]
    pub struct MockPendingOperation {
        id: H256,
        sender_address: H256,
        origin_domain_id: u32,
        destination_domain_id: u32,
        recipient_address: H256,
        seconds_to_next_attempt: u64,
        destination_domain: HyperlaneDomain,
        retry_count: u32,
        #[serde(skip)]
        pub mailbox: Option<Arc<dyn Mailbox>>,
    }

    impl MockPendingOperation {
        pub fn new(seconds_to_next_attempt: u64, destination_domain: HyperlaneDomain) -> Self {
            Self {
                id: H256::random(),
                seconds_to_next_attempt,
                destination_domain_id: destination_domain.id(),
                destination_domain,
                sender_address: H256::random(),
                recipient_address: H256::random(),
                origin_domain_id: 0,
                retry_count: 0,
                mailbox: None,
            }
        }

        pub fn with_message_data(message: HyperlaneMessage) -> Self {
            Self {
                id: message.id(),
                sender_address: message.sender,
                recipient_address: message.recipient,
                origin_domain_id: message.origin,
                destination_domain_id: message.destination,
                seconds_to_next_attempt: 0,
                retry_count: 0,
                destination_domain: HyperlaneDomain::Unknown {
                    domain_id: message.destination,
                    domain_name: "test".to_string(),
                    domain_type: HyperlaneDomainType::Unknown,
                    domain_protocol: HyperlaneDomainProtocol::Ethereum,
                    domain_technical_stack: HyperlaneDomainTechnicalStack::Other,
                },
                mailbox: None,
            }
        }

        pub fn with_id(self, id: &str) -> Self {
            Self {
                id: H256::from_str(id).unwrap(),
                ..self
            }
        }

        pub fn with_sender_address(self, sender_address: &str) -> Self {
            Self {
                sender_address: H256::from_str(sender_address).unwrap(),
                ..self
            }
        }

        pub fn with_recipient_address(self, recipient_address: &str) -> Self {
            Self {
                recipient_address: H256::from_str(recipient_address).unwrap(),
                ..self
            }
        }

        pub fn with_origin_domain(self, domain: HyperlaneDomain) -> Self {
            let domain_id = match domain {
                HyperlaneDomain::Known(d) => d as u32,
                HyperlaneDomain::Unknown { domain_id, .. } => domain_id,
            };
            Self {
                origin_domain_id: domain_id,
                ..self
            }
        }

        pub fn with_retry_count(mut self, retry_count: u32) -> Self {
            self.set_retries(retry_count);
            self
        }
    }

    impl TryBatchAs<HyperlaneMessage> for MockPendingOperation {}

    #[async_trait::async_trait]
    #[typetag::serialize]
    impl PendingOperation for MockPendingOperation {
        fn id(&self) -> H256 {
            self.id
        }

        fn status(&self) -> PendingOperationStatus {
            PendingOperationStatus::FirstPrepareAttempt
        }

        fn set_status(&mut self, _status: PendingOperationStatus) {}

        fn reset_attempts(&mut self) {
            self.seconds_to_next_attempt = 0;
        }

        fn sender_address(&self) -> &H256 {
            &self.sender_address
        }

        fn recipient_address(&self) -> &H256 {
            &self.recipient_address
        }

        fn get_metric(&self) -> Option<Arc<IntGauge>> {
            None
        }

        fn set_metric(&mut self, _metric: Arc<IntGauge>) {}

        fn priority(&self) -> u32 {
            todo!()
        }

        fn retrieve_status_from_db(&self) -> Option<PendingOperationStatus> {
            todo!()
        }

        fn get_operation_labels(&self) -> (String, String) {
            Default::default()
        }

        fn origin_domain_id(&self) -> u32 {
            self.origin_domain_id
        }

        fn destination_domain(&self) -> &HyperlaneDomain {
            &self.destination_domain
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

        fn set_submission_outcome(&mut self, _outcome: TxOutcome) {
            todo!()
        }

        fn get_tx_cost_estimate(&self) -> Option<U256> {
            todo!()
        }

        /// This will be called after the operation has been submitted and is
        /// responsible for checking if the operation has reached a point at
        /// which we consider it safe from reorgs.
        async fn confirm(&mut self) -> PendingOperationResult {
            todo!()
        }

        fn set_operation_outcome(
            &mut self,
            _submission_outcome: TxOutcome,
            _submission_estimated_cost: U256,
        ) {
            todo!()
        }

        fn next_attempt_after(&self) -> Option<Instant> {
            Some(
                Instant::now()
                    .checked_add(Duration::from_secs(self.seconds_to_next_attempt))
                    .unwrap(),
            )
        }

        fn set_next_attempt_after(&mut self, _delay: Duration) {
            todo!()
        }

        fn set_retries(&mut self, retries: u32) {
            self.retry_count = retries;
        }
        fn get_retries(&self) -> u32 {
            self.retry_count
        }

        async fn payload(&self) -> ChainResult<Vec<u8>> {
            todo!()
        }

        fn on_reprepare(
            &mut self,
            _err_msg: Option<String>,
            _: ReprepareReason,
        ) -> PendingOperationResult {
            todo!()
        }
    }

    pub fn dummy_metrics_and_label() -> (IntGaugeVec, String) {
        (
            IntGaugeVec::new(
                prometheus::Opts::new("op_queue", "OpQueue metrics"),
                &[
                    "destination",
                    "queue_metrics_label",
                    "operation_status",
                    "app_context",
                ],
            )
            .unwrap(),
            "queue_metrics_label".to_string(),
        )
    }

    fn initialize_queue(broadcaster: &sync::broadcast::Sender<MessageRetryRequest>) -> OpQueue {
        let (metrics, queue_metrics_label) = dummy_metrics_and_label();

        OpQueue::new(
            metrics.clone(),
            queue_metrics_label.clone(),
            Arc::new(Mutex::new(broadcaster.subscribe())),
        )
    }

    fn generate_test_messages(
        destination_domain: HyperlaneDomain,
        messages_to_send: u64,
    ) -> VecDeque<Box<dyn PendingOperation>> {
        let ops: VecDeque<_> = (1..=messages_to_send)
            .map(|seconds_to_next_attempt| {
                Box::new(MockPendingOperation::new(
                    seconds_to_next_attempt,
                    destination_domain.clone(),
                )) as QueueOperation
            })
            .collect();
        ops
    }

    #[tokio::test]
    async fn test_multiple_op_queues_message_id() {
        let broadcaster = sync::broadcast::Sender::new(100);

        let mut op_queue_1 = initialize_queue(&broadcaster);
        let mut op_queue_2 = initialize_queue(&broadcaster);

        // Add some operations to the queue with increasing `next_attempt_after` values
        let destination_domain: HyperlaneDomain = KnownHyperlaneDomain::Injective.into();
        let messages_to_send = 5;
        let mut ops = generate_test_messages(destination_domain, messages_to_send);
        let op_ids: Vec<_> = ops.iter().map(|op| op.id()).collect();

        // push to queue 1
        for _ in 0..=2 {
            op_queue_1
                .push(
                    ops.pop_front().unwrap(),
                    Some(PendingOperationStatus::FirstPrepareAttempt),
                )
                .await;
        }

        // push to queue 2
        for _ in 3..messages_to_send {
            op_queue_2
                .push(
                    ops.pop_front().unwrap(),
                    Some(PendingOperationStatus::FirstPrepareAttempt),
                )
                .await;
        }

        let (transmitter, _receiver) = mpsc::channel(ENDPOINT_MESSAGES_QUEUE_SIZE);

        // Retry by message ids
        broadcaster
            .send(MessageRetryRequest {
                uuid: "59400966-e7fa-4fb9-9372-9a671d4392c3".to_string(),
                pattern: MatchingList::with_message_id(op_ids[1]),
                transmitter: transmitter.clone(),
            })
            .unwrap();
        broadcaster
            .send(MessageRetryRequest {
                uuid: "59400966-e7fa-4fb9-9372-9a671d4392c3".to_string(),
                pattern: MatchingList::with_message_id(op_ids[2]),
                transmitter,
            })
            .unwrap();

        // Pop elements from queue 1
        let mut queue_1_popped = vec![];
        while let Some(op) = op_queue_1.pop().await {
            queue_1_popped.push(op);
        }

        // The elements sent over the channel should be the first ones popped,
        // regardless of their initial `next_attempt_after`
        assert_eq!(queue_1_popped[0].id(), op_ids[2]);
        assert_eq!(queue_1_popped[1].id(), op_ids[1]);
        assert_eq!(queue_1_popped[2].id(), op_ids[0]);

        // Pop elements from queue 2
        let mut queue_2_popped = vec![];
        while let Some(op) = op_queue_2.pop().await {
            queue_2_popped.push(op);
        }

        // The elements should be popped in the order they were pushed, because there was no retry request for them
        assert_eq!(queue_2_popped[0].id(), op_ids[3]);
        assert_eq!(queue_2_popped[1].id(), op_ids[4]);
    }

    #[tokio::test]
    async fn test_destination_domain() {
        let broadcaster = sync::broadcast::Sender::new(100);
        let mut op_queue = initialize_queue(&broadcaster);

        // Add some operations to the queue with increasing `next_attempt_after` values
        let destination_domain_1: HyperlaneDomain = KnownHyperlaneDomain::Injective.into();
        let destination_domain_2: HyperlaneDomain = KnownHyperlaneDomain::Ethereum.into();
        let ops = vec![
            Box::new(MockPendingOperation::new(1, destination_domain_1.clone())) as QueueOperation,
            Box::new(MockPendingOperation::new(2, destination_domain_1.clone())) as QueueOperation,
            Box::new(MockPendingOperation::new(3, destination_domain_2.clone())) as QueueOperation,
            Box::new(MockPendingOperation::new(4, destination_domain_2.clone())) as QueueOperation,
            Box::new(MockPendingOperation::new(5, destination_domain_2.clone())) as QueueOperation,
        ];

        let op_ids: Vec<_> = ops.iter().map(|op| op.id()).collect();

        // push to queue
        for op in ops {
            op_queue
                .push(op, Some(PendingOperationStatus::FirstPrepareAttempt))
                .await;
        }

        let (transmitter, mut receiver) = mpsc::channel(ENDPOINT_MESSAGES_QUEUE_SIZE);

        // Retry by domain
        broadcaster
            .send(MessageRetryRequest {
                uuid: "a5b39473-7cc5-48a1-8bed-565454ba1037".to_string(),
                pattern: MatchingList::with_destination_domain(destination_domain_2.id()),
                transmitter,
            })
            .unwrap();

        // Pop elements from queue
        let mut popped = vec![];
        while let Some(op) = op_queue.pop().await {
            popped.push(op.id());
        }

        // First messages should be those to `destination_domain_2` - their exact order depends on
        // how they were stored in the heap
        assert_eq!(popped[0], op_ids[2]);
        assert_eq!(popped[1], op_ids[4]);
        assert_eq!(popped[2], op_ids[3]);
        // Non-retried messages should be at the end
        assert_eq!(popped[3], op_ids[0]);
        assert_eq!(popped[4], op_ids[1]);

        let retry_response = receiver.recv().await.expect("No retry response received");

        assert_eq!(retry_response.evaluated, 5);
        assert_eq!(retry_response.matched, 3);
    }

    #[tracing_test::traced_test]
    #[tokio::test]
    async fn test_process_retry_requests_by_id() {
        let broadcaster = sync::broadcast::Sender::new(100);
        let mut op_queue_1 = initialize_queue(&broadcaster);

        // Add some operations to the queue with increasing `next_attempt_after` values
        let destination_domain: HyperlaneDomain = KnownHyperlaneDomain::Injective.into();
        let messages_to_send = 5;
        let ops = generate_test_messages(destination_domain, messages_to_send);
        let op_ids: Vec<_> = ops.iter().map(|op| op.id()).collect();

        // push to queue 1
        for op in ops {
            op_queue_1
                .push(op, Some(PendingOperationStatus::FirstPrepareAttempt))
                .await;
        }

        let (transmitter, mut receiver) = mpsc::channel(ENDPOINT_MESSAGES_QUEUE_SIZE);

        // Retry by message ids
        broadcaster
            .send(MessageRetryRequest {
                uuid: "0e92ace7-ba5d-4a1f-8501-51b6d9d500cf".to_string(),
                pattern: MatchingList::with_message_id(op_ids[1]),
                transmitter: transmitter.clone(),
            })
            .unwrap();

        op_queue_1.process_retry_requests().await;

        let retry_response = receiver.recv().await.unwrap();

        assert_eq!(retry_response.evaluated, 5);
        assert_eq!(retry_response.matched, 1);
    }

    #[tracing_test::traced_test]
    #[tokio::test]
    async fn test_process_retry_requests_empty_queue() {
        let broadcaster = sync::broadcast::Sender::new(100);
        let mut op_queue_1 = initialize_queue(&broadcaster);

        let (transmitter, mut receiver) = mpsc::channel(ENDPOINT_MESSAGES_QUEUE_SIZE);

        broadcaster
            .send(MessageRetryRequest {
                uuid: "0e92ace7-ba5d-4a1f-8501-51b6d9d500cf".to_string(),
                pattern: MatchingList::with_destination_domain(
                    KnownHyperlaneDomain::Arbitrum as u32,
                ),
                transmitter: transmitter.clone(),
            })
            .unwrap();

        op_queue_1.process_retry_requests().await;

        let retry_response = receiver.recv().await.unwrap();

        assert_eq!(retry_response.evaluated, 0);
        assert_eq!(retry_response.matched, 0);
    }

    #[tracing_test::traced_test]
    #[tokio::test]
    async fn test_process_retry_requests_all_wildcards() {
        let broadcaster = sync::broadcast::Sender::new(100);
        let mut op_queue_1 = initialize_queue(&broadcaster);

        // Add some operations to the queue with increasing `next_attempt_after` values
        let destination_domain: HyperlaneDomain = KnownHyperlaneDomain::Injective.into();
        let messages_to_send = 5;
        let ops = generate_test_messages(destination_domain, messages_to_send);

        // push to queue 1
        for op in ops {
            op_queue_1
                .push(op, Some(PendingOperationStatus::FirstPrepareAttempt))
                .await;
        }

        let (transmitter, mut receiver) = mpsc::channel(ENDPOINT_MESSAGES_QUEUE_SIZE);

        broadcaster
            .send(MessageRetryRequest {
                uuid: "0e92ace7-ba5d-4a1f-8501-51b6d9d500cf".to_string(),
                pattern: MatchingList(Some(vec![ListElement::new(
                    Filter::Wildcard,
                    Filter::Wildcard,
                    Filter::Wildcard,
                    Filter::Wildcard,
                    Filter::Wildcard,
                )])),
                transmitter: transmitter.clone(),
            })
            .unwrap();

        op_queue_1.process_retry_requests().await;

        let retry_response = receiver.recv().await.unwrap();

        assert_eq!(retry_response.evaluated, 5);
        assert_eq!(retry_response.matched, 5);
    }

    #[tracing_test::traced_test]
    #[tokio::test]
    async fn test_process_retry_requests_multiple_fields() {
        let broadcaster = sync::broadcast::Sender::new(100);
        let mut op_queue_1 = initialize_queue(&broadcaster);

        // Add some operations to the queue with increasing `next_attempt_after` values
        let destination_domain: HyperlaneDomain = KnownHyperlaneDomain::Injective.into();
        let messages_to_send = 5;
        let ops = generate_test_messages(destination_domain, messages_to_send);

        // push to queue 1
        for op in ops {
            op_queue_1
                .push(op, Some(PendingOperationStatus::FirstPrepareAttempt))
                .await;
        }

        let test_messages = [
            MockPendingOperation::new(10, KnownHyperlaneDomain::Arbitrum.into()),
            MockPendingOperation::new(10, KnownHyperlaneDomain::Optimism.into())
                .with_origin_domain(HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism)),
        ];
        for op in test_messages {
            op_queue_1
                .push(
                    Box::new(op) as QueueOperation,
                    Some(PendingOperationStatus::FirstPrepareAttempt),
                )
                .await;
        }

        let (transmitter, mut receiver) = mpsc::channel(ENDPOINT_MESSAGES_QUEUE_SIZE);

        broadcaster
            .send(MessageRetryRequest {
                uuid: "0e92ace7-ba5d-4a1f-8501-51b6d9d500cf".to_string(),
                pattern: MatchingList(Some(vec![ListElement::new(
                    Filter::Wildcard,
                    Filter::Enumerated(vec![KnownHyperlaneDomain::Optimism as u32]),
                    Filter::Wildcard,
                    Filter::Enumerated(vec![KnownHyperlaneDomain::Optimism as u32]),
                    Filter::Wildcard,
                )])),
                transmitter: transmitter.clone(),
            })
            .unwrap();

        op_queue_1.process_retry_requests().await;

        let retry_response = receiver.recv().await.unwrap();

        assert_eq!(retry_response.evaluated, 7);
        assert_eq!(retry_response.matched, 1);
    }

    #[tracing_test::traced_test]
    #[tokio::test]
    async fn test_process_retry_requests_multiple_list_elements() {
        let broadcaster = sync::broadcast::Sender::new(100);
        let mut op_queue_1 = initialize_queue(&broadcaster);

        // Add some operations to the queue with increasing `next_attempt_after` values
        let destination_domain: HyperlaneDomain = KnownHyperlaneDomain::Injective.into();
        let messages_to_send = 5;
        let ops = generate_test_messages(destination_domain, messages_to_send);

        // push to queue 1
        for op in ops {
            op_queue_1
                .push(op, Some(PendingOperationStatus::FirstPrepareAttempt))
                .await;
        }

        let test_messages = [
            MockPendingOperation::new(10, KnownHyperlaneDomain::Arbitrum.into()),
            MockPendingOperation::new(10, KnownHyperlaneDomain::Optimism.into())
                .with_origin_domain(HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism)),
        ];
        for op in test_messages {
            op_queue_1
                .push(
                    Box::new(op) as QueueOperation,
                    Some(PendingOperationStatus::FirstPrepareAttempt),
                )
                .await;
        }

        let (transmitter, mut receiver) = mpsc::channel(ENDPOINT_MESSAGES_QUEUE_SIZE);

        broadcaster
            .send(MessageRetryRequest {
                uuid: "0e92ace7-ba5d-4a1f-8501-51b6d9d500cf".to_string(),
                pattern: MatchingList(Some(vec![
                    ListElement::new(
                        Filter::Wildcard,
                        Filter::Enumerated(vec![KnownHyperlaneDomain::Optimism as u32]),
                        Filter::Wildcard,
                        Filter::Wildcard,
                        Filter::Wildcard,
                    ),
                    ListElement::new(
                        Filter::Wildcard,
                        Filter::Wildcard,
                        Filter::Wildcard,
                        Filter::Enumerated(vec![KnownHyperlaneDomain::Arbitrum as u32]),
                        Filter::Wildcard,
                    ),
                ])),
                transmitter: transmitter.clone(),
            })
            .unwrap();

        op_queue_1.process_retry_requests().await;

        let retry_response = receiver.recv().await.unwrap();

        assert_eq!(retry_response.evaluated, 7);
        assert_eq!(retry_response.matched, 2);
    }

    #[tracing_test::traced_test]
    #[tokio::test]
    async fn test_process_retry_requests_multiple_retries() {
        let broadcaster = sync::broadcast::Sender::new(100);
        let mut op_queue_1 = initialize_queue(&broadcaster);

        // Add some operations to the queue with increasing `next_attempt_after` values
        let destination_domain: HyperlaneDomain = KnownHyperlaneDomain::Injective.into();
        let messages_to_send = 5;
        let ops = generate_test_messages(destination_domain, messages_to_send);

        // push to queue 1
        for op in ops {
            op_queue_1
                .push(op, Some(PendingOperationStatus::FirstPrepareAttempt))
                .await;
        }

        let test_messages = [
            MockPendingOperation::new(10, KnownHyperlaneDomain::Arbitrum.into()),
            MockPendingOperation::new(10, KnownHyperlaneDomain::Optimism.into())
                .with_origin_domain(HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism)),
        ];
        for op in test_messages {
            op_queue_1
                .push(
                    Box::new(op) as QueueOperation,
                    Some(PendingOperationStatus::FirstPrepareAttempt),
                )
                .await;
        }

        let (transmitter, mut receiver) = mpsc::channel(ENDPOINT_MESSAGES_QUEUE_SIZE);

        let retry_req = MessageRetryRequest {
            uuid: "0e92ace7-ba5d-4a1f-8501-51b6d9d500cf".to_string(),
            pattern: MatchingList(Some(vec![
                ListElement::new(
                    Filter::Wildcard,
                    Filter::Enumerated(vec![KnownHyperlaneDomain::Optimism as u32]),
                    Filter::Wildcard,
                    Filter::Wildcard,
                    Filter::Wildcard,
                ),
                ListElement::new(
                    Filter::Wildcard,
                    Filter::Wildcard,
                    Filter::Wildcard,
                    Filter::Enumerated(vec![KnownHyperlaneDomain::Arbitrum as u32]),
                    Filter::Wildcard,
                ),
            ])),
            transmitter: transmitter.clone(),
        };

        broadcaster.send(retry_req.clone()).unwrap();

        op_queue_1.process_retry_requests().await;

        let retry_response = receiver.recv().await.unwrap();

        assert_eq!(retry_response.evaluated, 7);
        assert_eq!(retry_response.matched, 2);

        // try again
        broadcaster.send(retry_req.clone()).unwrap();

        op_queue_1.process_retry_requests().await;

        let retry_response = receiver.recv().await.unwrap();

        assert_eq!(retry_response.evaluated, 7);
        assert_eq!(retry_response.matched, 2);
    }
}
