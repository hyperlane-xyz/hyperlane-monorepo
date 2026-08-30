use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use prometheus::IntGauge;
use serde::Serialize;
use tokio::sync::{mpsc, Semaphore};

use hyperlane_core::{
    ChainResult, ConfirmReason, HyperlaneDomain, HyperlaneMessage, PendingOperation,
    PendingOperationResult, PendingOperationStatus, QueueOperation, ReprepareReason, TryBatchAs,
    TxOutcome, H256, U256,
};

use super::super::process_batch;
use super::tests_common::{create_test_metrics, create_test_queue};

#[derive(Debug, Default)]
struct PrepareConcurrency {
    active: AtomicUsize,
    max_active: AtomicUsize,
}

#[derive(Debug, Serialize)]
struct TestOperation {
    id: H256,
    origin: u32,
    destination: HyperlaneDomain,
    status: PendingOperationStatus,
    #[serde(skip_serializing)]
    prepare_result: Option<PendingOperationResult>,
    #[serde(skip_serializing)]
    gate: Option<Arc<Semaphore>>,
    #[serde(skip_serializing)]
    started: mpsc::UnboundedSender<H256>,
    #[serde(skip_serializing)]
    completed: mpsc::UnboundedSender<H256>,
    #[serde(skip_serializing)]
    disposed: mpsc::UnboundedSender<H256>,
    #[serde(skip_serializing)]
    concurrency: Arc<PrepareConcurrency>,
}

impl TestOperation {
    #[allow(clippy::too_many_arguments)]
    fn new(
        id: u64,
        origin: u32,
        destination: HyperlaneDomain,
        prepare_result: PendingOperationResult,
        gate: Option<Arc<Semaphore>>,
        started: mpsc::UnboundedSender<H256>,
        completed: mpsc::UnboundedSender<H256>,
        disposed: mpsc::UnboundedSender<H256>,
        concurrency: Arc<PrepareConcurrency>,
    ) -> Self {
        Self {
            id: H256::from_low_u64_be(id),
            origin,
            destination,
            status: PendingOperationStatus::FirstPrepareAttempt,
            prepare_result: Some(prepare_result),
            gate,
            started,
            completed,
            disposed,
            concurrency,
        }
    }
}

#[async_trait]
#[typetag::serialize]
impl PendingOperation for TestOperation {
    fn id(&self) -> H256 {
        self.id
    }

    fn priority(&self) -> u32 {
        self.id.to_low_u64_be() as u32
    }

    fn origin_domain_id(&self) -> u32 {
        self.origin
    }

    fn retrieve_status_from_db(&self) -> Option<PendingOperationStatus> {
        Some(self.status.clone())
    }

    fn destination_domain(&self) -> &HyperlaneDomain {
        &self.destination
    }

    fn sender_address(&self) -> &H256 {
        &self.id
    }

    fn recipient_address(&self) -> &H256 {
        &self.id
    }

    fn body(&self) -> &[u8] {
        &[]
    }

    fn app_context(&self) -> Option<String> {
        None
    }

    fn get_metric(&self) -> Option<Arc<IntGauge>> {
        None
    }

    fn set_metric(&mut self, _metric: Arc<IntGauge>) {
        self.disposed.send(self.id).expect("disposition receiver");
    }

    fn status(&self) -> PendingOperationStatus {
        self.status.clone()
    }

    fn set_status(&mut self, status: PendingOperationStatus) {
        self.status = status;
    }

    async fn prepare(&mut self) -> PendingOperationResult {
        let active = self.concurrency.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.concurrency
            .max_active
            .fetch_max(active, Ordering::SeqCst);
        self.started.send(self.id).expect("started receiver");

        if let Some(gate) = &self.gate {
            gate.acquire().await.expect("gate open").forget();
        }

        self.completed.send(self.id).expect("completed receiver");
        self.concurrency.active.fetch_sub(1, Ordering::SeqCst);
        self.prepare_result.take().expect("single prepare call")
    }

    async fn submit(&mut self) -> PendingOperationResult {
        unimplemented!()
    }

    fn set_submission_outcome(&mut self, _outcome: TxOutcome) {}

    fn get_tx_cost_estimate(&self) -> Option<U256> {
        None
    }

    async fn confirm(&mut self) -> PendingOperationResult {
        unimplemented!()
    }

    async fn set_operation_outcome(
        &mut self,
        _submission_outcome: TxOutcome,
        _submission_estimated_cost: U256,
    ) {
    }

    fn next_attempt_after(&self) -> Option<Instant> {
        None
    }

    fn set_next_attempt_after(&mut self, _delay: Duration) {}

    fn reset_attempts(&mut self) {}

    fn set_retries(&mut self, _retries: u32) {}

    fn get_retries(&self) -> u32 {
        0
    }

    async fn payload(&self) -> ChainResult<Vec<u8>> {
        unimplemented!()
    }

    fn success_criteria(&self) -> ChainResult<Option<Vec<u8>>> {
        unimplemented!()
    }

    fn on_reprepare(
        &mut self,
        _err_msg: Option<String>,
        reason: ReprepareReason,
    ) -> PendingOperationResult {
        PendingOperationResult::Reprepare(reason)
    }
}

impl TryBatchAs<HyperlaneMessage> for TestOperation {}

struct TestHarness {
    destination: HyperlaneDomain,
    started_tx: mpsc::UnboundedSender<H256>,
    started_rx: mpsc::UnboundedReceiver<H256>,
    completed_tx: mpsc::UnboundedSender<H256>,
    completed_rx: mpsc::UnboundedReceiver<H256>,
    disposed_tx: mpsc::UnboundedSender<H256>,
    disposed_rx: mpsc::UnboundedReceiver<H256>,
    concurrency: Arc<PrepareConcurrency>,
}

impl TestHarness {
    fn new() -> Self {
        let (started_tx, started_rx) = mpsc::unbounded_channel();
        let (completed_tx, completed_rx) = mpsc::unbounded_channel();
        let (disposed_tx, disposed_rx) = mpsc::unbounded_channel();
        Self {
            destination: HyperlaneDomain::new_test_domain("test"),
            started_tx,
            started_rx,
            completed_tx,
            completed_rx,
            disposed_tx,
            disposed_rx,
            concurrency: Arc::new(PrepareConcurrency::default()),
        }
    }

    fn operation(
        &self,
        id: u64,
        origin: u32,
        result: PendingOperationResult,
        gate: Option<Arc<Semaphore>>,
    ) -> QueueOperation {
        Box::new(TestOperation::new(
            id,
            origin,
            self.destination.clone(),
            result,
            gate,
            self.started_tx.clone(),
            self.completed_tx.clone(),
            self.disposed_tx.clone(),
            self.concurrency.clone(),
        ))
    }
}

async fn run_process_batch(
    destination: HyperlaneDomain,
    batch: Vec<QueueOperation>,
) -> (
    super::super::OpQueue,
    super::super::OpQueue,
    super::super::OpQueue,
    super::super::MessageProcessorMetrics,
) {
    let mut prepare_queue = create_test_queue();
    let submit_queue = create_test_queue();
    let confirm_queue = create_test_queue();
    let metrics = create_test_metrics();

    process_batch(
        destination,
        batch,
        &mut prepare_queue,
        &submit_queue,
        &confirm_queue,
        &metrics,
    )
    .await;

    (prepare_queue, submit_queue, confirm_queue, metrics)
}

#[tokio::test]
async fn slow_origin_does_not_block_fast_origin_disposition() {
    let mut harness = TestHarness::new();
    let slow_gate = Arc::new(Semaphore::new(0));
    let slow_id = H256::from_low_u64_be(1);
    let fast_id = H256::from_low_u64_be(2);
    let batch = vec![
        harness.operation(
            1,
            1000,
            PendingOperationResult::Success,
            Some(slow_gate.clone()),
        ),
        harness.operation(2, 2000, PendingOperationResult::Success, None),
    ];

    let task = tokio::spawn(run_process_batch(harness.destination.clone(), batch));

    for _ in 0..2 {
        harness.started_rx.recv().await.expect("prepare started");
    }
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), harness.disposed_rx.recv())
            .await
            .expect("fast origin should be disposed")
            .expect("disposition event"),
        fast_id
    );

    slow_gate.add_permits(1);
    assert_eq!(
        harness.disposed_rx.recv().await.expect("slow disposition"),
        slow_id
    );
    task.await.expect("process task");
}

#[tokio::test]
async fn same_origin_dispositions_preserve_batch_order() {
    let mut harness = TestHarness::new();
    let first_gate = Arc::new(Semaphore::new(0));
    let first_id = H256::from_low_u64_be(1);
    let second_id = H256::from_low_u64_be(2);
    let batch = vec![
        harness.operation(
            1,
            1000,
            PendingOperationResult::Success,
            Some(first_gate.clone()),
        ),
        harness.operation(2, 1000, PendingOperationResult::Success, None),
    ];

    let task = tokio::spawn(run_process_batch(harness.destination.clone(), batch));

    assert_eq!(
        harness.completed_rx.recv().await.expect("completion event"),
        second_id
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(50), harness.disposed_rx.recv())
            .await
            .is_err(),
        "later same-origin operation must wait for its predecessor"
    );

    first_gate.add_permits(1);
    assert_eq!(harness.disposed_rx.recv().await.unwrap(), first_id);
    assert_eq!(harness.disposed_rx.recv().await.unwrap(), second_id);
    task.await.expect("process task");
}

#[tokio::test]
async fn preparation_concurrency_is_bounded_by_batch_size() {
    let mut harness = TestHarness::new();
    let gate = Arc::new(Semaphore::new(0));
    let batch_size = 4;
    let batch = (0..batch_size)
        .map(|i| {
            harness.operation(
                i as u64 + 1,
                i as u32 + 1,
                PendingOperationResult::Success,
                Some(gate.clone()),
            )
        })
        .collect();

    let task = tokio::spawn(run_process_batch(harness.destination.clone(), batch));
    for _ in 0..batch_size {
        harness.started_rx.recv().await.expect("prepare started");
    }
    assert_eq!(
        harness.concurrency.max_active.load(Ordering::SeqCst),
        batch_size
    );

    gate.add_permits(batch_size);
    task.await.expect("process task");
    assert_eq!(harness.concurrency.active.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn completed_results_keep_existing_dispositions_and_metrics() {
    let harness = TestHarness::new();
    let success_id = H256::from_low_u64_be(1);
    let not_ready_id = H256::from_low_u64_be(2);
    let reprepare_id = H256::from_low_u64_be(3);
    let confirm_id = H256::from_low_u64_be(5);
    let batch = vec![
        harness.operation(1, 1, PendingOperationResult::Success, None),
        harness.operation(2, 2, PendingOperationResult::NotReady, None),
        harness.operation(
            3,
            3,
            PendingOperationResult::Reprepare(ReprepareReason::Manual),
            None,
        ),
        harness.operation(4, 4, PendingOperationResult::Drop, None),
        harness.operation(
            5,
            5,
            PendingOperationResult::Confirm(ConfirmReason::AlreadySubmitted),
            None,
        ),
    ];

    let (mut prepare_queue, mut submit_queue, mut confirm_queue, metrics) =
        run_process_batch(harness.destination, batch).await;

    let submitted = submit_queue.pop_many(10).await;
    assert_eq!(submitted.len(), 1);
    assert_eq!(submitted[0].id(), success_id);
    assert_eq!(submitted[0].status(), PendingOperationStatus::ReadyToSubmit);

    let prepared = prepare_queue.pop_many(10).await;
    assert_eq!(prepared.len(), 2);
    assert!(prepared.iter().any(|op| {
        op.id() == not_ready_id && op.status() == PendingOperationStatus::FirstPrepareAttempt
    }));
    assert!(prepared.iter().any(|op| {
        op.id() == reprepare_id
            && op.status() == PendingOperationStatus::Retry(ReprepareReason::Manual)
    }));

    let confirmed = confirm_queue.pop_many(10).await;
    assert_eq!(confirmed.len(), 1);
    assert_eq!(confirmed[0].id(), confirm_id);
    assert_eq!(
        confirmed[0].status(),
        PendingOperationStatus::Confirm(ConfirmReason::AlreadySubmitted)
    );

    assert_eq!(
        metrics
            .ops_prepared
            .with_label_values(&["test", "prepared", "Unknown"])
            .get(),
        1
    );
    assert_eq!(
        metrics
            .ops_failed
            .with_label_values(&["test", "failed", "Unknown"])
            .get(),
        1
    );
    assert_eq!(
        metrics
            .ops_dropped
            .with_label_values(&["test", "dropped", "Unknown"])
            .get(),
        1
    );
}
