use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use hyperlane_core::{
    identifiers::UniqueIdentifier, ConfirmReason, HyperlaneDomain, HyperlaneDomainProtocol,
    HyperlaneDomainTechnicalStack, HyperlaneDomainType, PendingOperationStatus, ReprepareReason,
    H256,
};
use lander::{PayloadStatus, TransactionStatus};
use tokio::time::{sleep, timeout};
use uuid::Uuid;

use super::super::confirm_classic_task;
use super::tests_common::{
    create_test_metrics, create_test_queue, MockDispatcherEntrypoint, MockHyperlaneDb,
    MockQueueOperation,
};

#[tokio::test]
async fn finality_waiter_yields_to_later_confirmations() {
    check_finality_queue_progress(true).await;
}

#[tokio::test]
async fn finalized_transaction_still_requires_individual_delivery() {
    check_finality_queue_progress(false).await;
}

async fn check_finality_queue_progress(delivered: bool) {
    let domain = HyperlaneDomain::Unknown {
        domain_id: 13375,
        domain_name: "sealeveltest1".to_owned(),
        domain_type: HyperlaneDomainType::LocalTestChain,
        domain_protocol: HyperlaneDomainProtocol::Sealevel,
        domain_technical_stack: HyperlaneDomainTechnicalStack::Other,
    };
    let waiting_id = H256::from_low_u64_be(1);
    let finalized_id = H256::from_low_u64_be(2);
    let waiting_payload = UniqueIdentifier::new(Uuid::new_v4());
    let finalized_payload = UniqueIdentifier::new(Uuid::new_v4());
    let db_waiting_payload = waiting_payload.clone();
    let mut db = MockHyperlaneDb::new();
    db.expect_retrieve_payload_uuids_by_message_id()
        .returning(move |id| {
            Ok(Some(vec![if *id == waiting_id {
                db_waiting_payload.clone()
            } else {
                assert_eq!(*id, finalized_id);
                finalized_payload.clone()
            }]))
        });
    let finalized = Arc::new(AtomicBool::new(false));
    let entrypoint_finalized = finalized.clone();
    let mut entrypoint = MockDispatcherEntrypoint::new();
    entrypoint.expect_payload_status().returning(move |uuid| {
        let status = if uuid == waiting_payload && !entrypoint_finalized.load(Ordering::SeqCst) {
            TransactionStatus::Included
        } else {
            TransactionStatus::Finalized
        };
        Ok(PayloadStatus::InTransaction(status))
    });

    let status = PendingOperationStatus::Confirm(ConfirmReason::SubmittedBySelf);
    let now = Instant::now();
    let expired_deadline = now - Duration::from_secs(2);
    let mut waiting = MockQueueOperation::new(waiting_id, status.clone(), domain.clone());
    waiting.next_attempt = Some(expired_deadline);
    waiting.retries = 7;
    waiting.delivered = Some(delivered);
    let waiting_confirmations = waiting.confirmations.clone();
    let mut later = MockQueueOperation::new(finalized_id, status.clone(), domain.clone());
    later.next_attempt = Some(now - Duration::from_secs(1));
    later.delivered = Some(true);
    let later_confirmations = later.confirmations.clone();
    let mut prepare_queue = create_test_queue();
    let confirm_queue = create_test_queue();
    confirm_queue.push(Box::new(waiting), None).await;
    confirm_queue.push(Box::new(later), None).await;
    let metrics = create_test_metrics();
    let handle = tokio::spawn(confirm_classic_task(
        domain,
        prepare_queue.clone(),
        confirm_queue.clone(),
        1,
        metrics.clone(),
        Some(Arc::new(entrypoint)),
        Arc::new(db),
    ));

    let result = timeout(Duration::from_secs(5), async {
        // Batch size one must still reach the later, finalized operation while
        // the oldest operation remains included but unfinalized.
        loop {
            let queue = confirm_queue.queue.lock().await;
            if later_confirmations.load(Ordering::SeqCst) == 1 {
                if let Some(waiting) = queue.iter().find(|op| op.0.id() == waiting_id) {
                    assert!(waiting.0.next_attempt_after().unwrap() > expired_deadline);
                    assert_eq!(waiting.0.get_retries(), 7);
                    assert_eq!(waiting.0.status(), status);
                    break;
                }
            }
            drop(queue);
            sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(waiting_confirmations.load(Ordering::SeqCst), 0);
        assert_eq!(prepare_queue.len().await, 0);

        finalized.store(true, Ordering::SeqCst);
        while waiting_confirmations.load(Ordering::SeqCst) == 0
            || confirm_queue.len().await != 0
            || (!delivered && prepare_queue.len().await != 1)
        {
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    handle.abort();
    let _ = handle.await;
    result.expect("finality waiters must not starve later confirmations");

    assert_eq!(waiting_confirmations.load(Ordering::SeqCst), 1);
    assert_eq!(later_confirmations.load(Ordering::SeqCst), 1);
    let confirmed = metrics
        .ops_confirmed
        .with_label_values(&["test", "confirmed", "Unknown"])
        .get();
    if delivered {
        assert_eq!(prepare_queue.len().await, 0);
        assert_eq!(confirmed, 2);
    } else {
        let op = prepare_queue
            .pop()
            .await
            .expect("undelivered message must retry");
        assert_eq!(op.id(), waiting_id);
        assert_eq!(
            op.status(),
            PendingOperationStatus::Retry(ReprepareReason::RevertedOrReorged)
        );
        assert_eq!(confirmed, 1);
    }
}
