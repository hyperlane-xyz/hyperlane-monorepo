mod confirmation;
pub(crate) mod tests_common;

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use hyperlane_core::{PendingOperationStatus, QueueOperation, H256};
use tokio::sync::{mpsc, Semaphore};
use tokio::time::timeout;

use super::{receive_task, RecoveryWaiter, MESSAGE_PROCESSOR_INGRESS_CAPACITY};
use crate::msg::QueueOperationBatch;
use tests_common::{create_test_queue, MockQueueOperation};

struct TestRecoveryWaiter(Arc<Semaphore>);

#[async_trait]
impl RecoveryWaiter for TestRecoveryWaiter {
    async fn wait_for_recovery(&self) {
        self.0
            .acquire()
            .await
            .expect("test recovery semaphore should remain open")
            .forget();
    }
}

#[tokio::test]
async fn test_recovery_backpressures_message_processor_ingress() {
    let domain = hyperlane_core::HyperlaneDomain::new_test_domain("test");
    let prepare_queue = create_test_queue();
    let recovery = Arc::new(Semaphore::new(0));
    let recovery_waiter: Arc<dyn RecoveryWaiter> = Arc::new(TestRecoveryWaiter(recovery.clone()));
    let (send_channel, receive_channel) =
        mpsc::channel::<QueueOperationBatch>(MESSAGE_PROCESSOR_INGRESS_CAPACITY);

    let receive_handle = tokio::spawn(receive_task(
        domain.clone(),
        receive_channel,
        prepare_queue.clone(),
        Some(recovery_waiter),
    ));
    let first_operation: QueueOperation = Box::new(MockQueueOperation::new(
        H256::from_low_u64_be(1),
        PendingOperationStatus::FirstPrepareAttempt,
        domain.clone(),
    ));
    send_channel
        .send(vec![first_operation])
        .await
        .expect("first operation should fill the ingress slot");

    let second_send_channel = send_channel.clone();
    let second_operation: QueueOperation = Box::new(MockQueueOperation::new(
        H256::from_low_u64_be(2),
        PendingOperationStatus::FirstPrepareAttempt,
        domain,
    ));
    let mut blocked_send =
        tokio::spawn(async move { second_send_channel.send(vec![second_operation]).await });

    assert!(timeout(Duration::from_millis(20), &mut blocked_send)
        .await
        .is_err());
    assert_eq!(prepare_queue.len().await, 0);

    recovery.add_permits(1);
    timeout(Duration::from_secs(1), &mut blocked_send)
        .await
        .expect("second producer should unblock after recovery")
        .expect("second producer task should not panic")
        .expect("receiver should remain open");

    timeout(Duration::from_secs(1), async {
        while prepare_queue.len().await != 2 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("both operations should drain after recovery");

    drop(send_channel);
    receive_handle
        .await
        .expect("receive task should stop when ingress closes");
}
mod tests_process_batch;

#[tokio::test]
async fn lander_submission_carries_the_policy_selected_budget() {
    use hyperlane_core::{HyperlaneDomain, U256};
    use hyperlane_test::mocks::MockMailboxContract;
    use tests_common::{MockDispatcherEntrypoint, MockHyperlaneDb};

    let mut mailbox = MockMailboxContract::new();
    mailbox.expect__address().once().return_const(H256::zero());
    let mut op = MockQueueOperation::new(
        H256::from_low_u64_be(1),
        PendingOperationStatus::ReadyToSubmit,
        HyperlaneDomain::new_test_domain("test"),
    );
    op.gas_limit = Some(U256::from(1_011_344));
    op.payload_data = vec![1, 2, 3];
    op.mailbox = Some(Arc::new(mailbox));
    let mut entrypoint = MockDispatcherEntrypoint::new();
    entrypoint
        .expect_send_payload()
        .once()
        .withf(|payload| payload.gas_limit == U256::from(1_011_344) && payload.data == [1, 2, 3])
        .returning(|_| Ok(()));
    let mut db = MockHyperlaneDb::new();
    db.expect_store_payload_uuids_by_message_id()
        .once()
        .returning(|_, _| Ok(()));
    let prepare_queue = create_test_queue();
    let submit_queue = create_test_queue();

    super::submit_via_lander(
        Box::new(op),
        &Arc::new(entrypoint),
        &prepare_queue,
        &submit_queue,
        Arc::new(db),
    )
    .await;

    assert_eq!(prepare_queue.len().await, 0);
    assert_eq!(submit_queue.len().await, 1);
}

#[tokio::test]
async fn lander_submission_without_gas_budget_returns_to_prepare() {
    use hyperlane_core::{HyperlaneDomain, ReprepareReason};
    use tests_common::{MockDispatcherEntrypoint, MockHyperlaneDb};

    let op = MockQueueOperation::new(
        H256::from_low_u64_be(1),
        PendingOperationStatus::ReadyToSubmit,
        HyperlaneDomain::new_test_domain("test"),
    );
    let mut prepare_queue = create_test_queue();
    let submit_queue = create_test_queue();
    super::submit_via_lander(
        Box::new(op),
        &Arc::new(MockDispatcherEntrypoint::new()),
        &prepare_queue,
        &submit_queue,
        Arc::new(MockHyperlaneDb::new()),
    )
    .await;

    assert_eq!(submit_queue.len().await, 0);
    let op = prepare_queue.pop().await.unwrap();
    assert_eq!(
        op.status(),
        PendingOperationStatus::Retry(ReprepareReason::ErrorCreatingPayload)
    );
}
