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
        &crate::msg::runtime_denylist::RuntimeDenylist::default(),
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
        &crate::msg::runtime_denylist::RuntimeDenylist::default(),
    )
    .await;

    assert_eq!(submit_queue.len().await, 0);
    let op = prepare_queue.pop().await.unwrap();
    assert_eq!(
        op.status(),
        PendingOperationStatus::Retry(ReprepareReason::ErrorCreatingPayload)
    );
}

fn submission_test_op(id: u64) -> MockQueueOperation {
    let mut mailbox = hyperlane_test::mocks::MockMailboxContract::new();
    mailbox.expect__address().return_const(H256::zero());
    let mut op = MockQueueOperation::new(
        H256::from_low_u64_be(id),
        PendingOperationStatus::ReadyToSubmit,
        hyperlane_core::HyperlaneDomain::new_test_domain("test"),
    );
    op.gas_limit = Some(100.into());
    op.mailbox = Some(Arc::new(mailbox));
    op
}

fn deny_message(denylist: &crate::msg::runtime_denylist::RuntimeDenylist, id: H256) {
    denylist.set_rules_for_test(serde_json::json!([
        { "reason": "test", "addedBy": "test", "match": { "messageId": format!("{id:?}") } }
    ]));
}

#[tokio::test]
async fn lander_submission_rechecks_rules_after_payload_construction() {
    use crate::msg::runtime_denylist::RuntimeDenylist;
    use tests_common::{MockDispatcherEntrypoint, MockHyperlaneDb};
    use tokio::sync::Notify;

    let gate = Arc::new((Notify::new(), Notify::new()));
    let mut op = submission_test_op(1);
    op.payload_gate = Some(gate.clone());
    let id = op.id;
    let denylist = Arc::new(RuntimeDenylist::default());
    let task_denylist = denylist.clone();
    let prepare_queue = create_test_queue();
    let submit_queue = create_test_queue();
    let task_prepare_queue = prepare_queue.clone();
    let task_submit_queue = submit_queue.clone();
    let task = tokio::spawn(async move {
        // No send or DB write is expected for a rule added during payload construction.
        super::submit_via_lander(
            Box::new(op),
            &Arc::new(MockDispatcherEntrypoint::new()),
            &task_prepare_queue,
            &task_submit_queue,
            Arc::new(MockHyperlaneDb::new()),
            &task_denylist,
        )
        .await;
    });
    timeout(Duration::from_secs(1), gate.0.notified())
        .await
        .unwrap();
    deny_message(&denylist, id);
    gate.1.notify_one();
    timeout(Duration::from_secs(1), task)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(prepare_queue.len().await, 0);
    assert_eq!(submit_queue.len().await, 0);
}

#[tokio::test]
async fn lander_submission_rechecks_later_operations_in_a_stalled_batch() {
    use crate::msg::runtime_denylist::RuntimeDenylist;
    use tests_common::{
        create_test_metrics, MockDispatcherEntrypoint, MockHyperlaneDb, NotifyOnDrop,
    };
    use tokio::sync::Notify;

    let gate = Arc::new((Notify::new(), Notify::new()));
    let mut first = submission_test_op(1);
    first.payload_gate = Some(gate.clone());
    let released = Arc::new(Notify::new());
    let mut second = submission_test_op(2);
    second.released = Some(Arc::new(NotifyOnDrop(released.clone())));
    let second_id = second.id;
    let submit_queue = create_test_queue();
    submit_queue.push(Box::new(first), None).await;
    submit_queue.push(Box::new(second), None).await;
    let mut entrypoint = MockDispatcherEntrypoint::new();
    entrypoint
        .expect_send_payload()
        .once()
        .returning(|_| Ok(()));
    let mut db = MockHyperlaneDb::new();
    db.expect_retrieve_payload_uuids_by_message_id()
        .returning(|_| Ok(None));
    db.expect_store_payload_uuids_by_message_id()
        .once()
        .returning(|_, _| Ok(()));
    let denylist = Arc::new(RuntimeDenylist::default());
    let task = tokio::spawn(super::submit_lander_task(
        Arc::new(entrypoint),
        hyperlane_core::HyperlaneDomain::new_test_domain("test"),
        create_test_queue(),
        submit_queue,
        create_test_queue(),
        2,
        create_test_metrics(),
        Arc::new(db),
        denylist.clone(),
    ));
    timeout(Duration::from_secs(1), gate.0.notified())
        .await
        .unwrap();
    deny_message(&denylist, second_id);
    gate.1.notify_one();
    timeout(Duration::from_secs(1), released.notified())
        .await
        .unwrap();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
}
