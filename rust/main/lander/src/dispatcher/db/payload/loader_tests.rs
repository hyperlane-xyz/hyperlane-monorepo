use std::sync::Arc;
use std::time::Duration;

use hyperlane_base::db::{HyperlaneRocksDB, DB};
use hyperlane_core::KnownHyperlaneDomain;
use tokio::sync::mpsc;

use crate::{
    dispatcher::{BuildingStageQueue, LoadableFromDb},
    payload::{FullPayload, PayloadStatus},
    transaction::TransactionStatus,
};

use super::{PayloadDb, PayloadDbLoader};

fn tmp_db() -> Arc<dyn PayloadDb> {
    let temp_dir = tempfile::tempdir().unwrap();
    let db = DB::from_path(temp_dir.path()).unwrap();
    let domain = KnownHyperlaneDomain::Arbitrum.into();

    (Arc::new(HyperlaneRocksDB::new(&domain, db))) as _
}

#[tokio::test]
async fn test_push_back_sends_notification_when_capacity_available() {
    let db = tmp_db();
    let (sender, mut receiver) = mpsc::channel(1);
    let queue = BuildingStageQueue::new();
    let loader = PayloadDbLoader::new(db, sender, queue.clone(), "test_domain".to_string());

    let payload = FullPayload::random();

    // Push a payload - should send notification since capacity is 1
    loader.push_back(payload.clone()).await;

    // Verify the notification was sent
    let notification_received = tokio::time::timeout(Duration::from_millis(100), receiver.recv())
        .await
        .expect("Timeout waiting for notification")
        .expect("Channel closed unexpectedly");

    assert_eq!(notification_received, ());
    assert_eq!(queue.len().await, 1);
}

#[tokio::test]
async fn test_push_back_does_not_send_notification_when_capacity_zero() {
    let db = tmp_db();
    let (sender, mut receiver) = mpsc::channel(1);
    let queue = BuildingStageQueue::new();
    let loader = PayloadDbLoader::new(db, sender, queue.clone(), "test_domain".to_string());

    let payload1 = FullPayload::random();
    let payload2 = FullPayload::random();

    // First push should send notification
    loader.push_back(payload1.clone()).await;

    // Verify first notification was sent
    tokio::time::timeout(Duration::from_millis(100), receiver.recv())
        .await
        .expect("Timeout waiting for first notification")
        .expect("Channel closed unexpectedly");

    // Channel capacity is now 0 (notification not consumed from sender's perspective)
    // Second push should NOT send notification
    loader.push_back(payload2.clone()).await;

    // Try to receive again - should timeout because no second notification was sent
    let result = tokio::time::timeout(Duration::from_millis(100), receiver.recv()).await;
    assert!(
        result.is_err(),
        "Expected timeout, but received a notification"
    );

    // Both payloads should still be in the queue
    assert_eq!(queue.len().await, 2);
}

#[tokio::test]
async fn test_push_back_sends_notification_after_capacity_restored() {
    let db = tmp_db();
    let (sender, mut receiver) = mpsc::channel(1);
    let queue = BuildingStageQueue::new();
    let loader = PayloadDbLoader::new(db, sender, queue.clone(), "test_domain".to_string());

    let payload1 = FullPayload::random();
    let payload2 = FullPayload::random();

    // First push sends notification
    loader.push_back(payload1.clone()).await;
    receiver
        .recv()
        .await
        .expect("Failed to receive first notification");

    // Second push - no notification because capacity is 0
    loader.push_back(payload2.clone()).await;

    // Third push - capacity should be restored, should send notification
    let payload3 = FullPayload::random();
    loader.push_back(payload3.clone()).await;

    // Should receive the second notification
    let notification_received = tokio::time::timeout(Duration::from_millis(100), receiver.recv())
        .await
        .expect("Timeout waiting for second notification")
        .expect("Channel closed unexpectedly");

    assert_eq!(notification_received, ());
    assert_eq!(queue.len().await, 3);
}

#[tokio::test]
async fn test_load_calls_push_back_for_ready_to_submit() {
    let db = tmp_db();
    let (sender, mut receiver) = mpsc::channel(1);
    let queue = BuildingStageQueue::new();
    let loader = PayloadDbLoader::new(db.clone(), sender, queue.clone(), "test_domain".to_string());

    let mut payload = FullPayload::random();
    payload.status = PayloadStatus::ReadyToSubmit;

    // Store the payload in the database first
    db.store_payload_by_uuid(&payload).await.unwrap();

    // Load the payload
    let result = loader.load(payload.clone()).await;
    assert!(result.is_ok());

    // Verify notification was sent
    let notification_received = tokio::time::timeout(Duration::from_millis(100), receiver.recv())
        .await
        .expect("Timeout waiting for notification")
        .expect("Channel closed unexpectedly");

    assert_eq!(notification_received, ());
    assert_eq!(queue.len().await, 1);
}

#[tokio::test]
async fn test_load_calls_push_back_for_retry_status() {
    let db = tmp_db();
    let (sender, mut receiver) = mpsc::channel(1);
    let queue = BuildingStageQueue::new();
    let loader = PayloadDbLoader::new(db.clone(), sender, queue.clone(), "test_domain".to_string());

    let mut payload = FullPayload::random();
    payload.status = PayloadStatus::Retry(3);

    // Store the payload in the database first
    db.store_payload_by_uuid(&payload).await.unwrap();

    // Load the payload
    let result = loader.load(payload.clone()).await;
    assert!(result.is_ok());

    // Verify notification was sent
    let notification_received = tokio::time::timeout(Duration::from_millis(100), receiver.recv())
        .await
        .expect("Timeout waiting for notification")
        .expect("Channel closed unexpectedly");

    assert_eq!(notification_received, ());
    assert_eq!(queue.len().await, 1);
}

#[tokio::test]
async fn test_load_does_not_send_notification_for_in_transaction_status() {
    let db = tmp_db();
    let (sender, mut receiver) = mpsc::channel(1);
    let queue = BuildingStageQueue::new();
    let loader = PayloadDbLoader::new(db.clone(), sender, queue.clone(), "test_domain".to_string());

    let mut payload = FullPayload::random();
    payload.status = PayloadStatus::InTransaction(TransactionStatus::PendingInclusion);

    // Store the payload in the database first
    db.store_payload_by_uuid(&payload).await.unwrap();

    // Load the payload
    let result = loader.load(payload.clone()).await;
    assert!(result.is_ok());

    // Verify no notification was sent
    let result = tokio::time::timeout(Duration::from_millis(100), receiver.recv()).await;
    assert!(
        result.is_err(),
        "Expected no notification for InTransaction status"
    );

    // Queue should be empty
    assert_eq!(queue.len().await, 0);
}

#[tokio::test]
async fn test_multiple_payloads_with_mixed_statuses() {
    let db = tmp_db();
    let (sender, mut receiver) = mpsc::channel(10);
    let queue = BuildingStageQueue::new();
    let loader = PayloadDbLoader::new(db.clone(), sender, queue.clone(), "test_domain".to_string());

    let mut payload1 = FullPayload::random();
    payload1.status = PayloadStatus::ReadyToSubmit;

    let mut payload2 = FullPayload::random();
    payload2.status = PayloadStatus::InTransaction(TransactionStatus::PendingInclusion);

    let mut payload3 = FullPayload::random();
    payload3.status = PayloadStatus::Retry(1);

    // Store payloads in database
    db.store_payload_by_uuid(&payload1).await.unwrap();
    db.store_payload_by_uuid(&payload2).await.unwrap();
    db.store_payload_by_uuid(&payload3).await.unwrap();

    // Load all payloads
    loader.load(payload1.clone()).await.unwrap();
    loader.load(payload2.clone()).await.unwrap();
    loader.load(payload3.clone()).await.unwrap();

    // Should have received notifications for payload1 and payload3
    let first_notification =
        tokio::time::timeout(Duration::from_millis(100), receiver.recv()).await;
    assert!(first_notification.is_ok(), "Expected first notification");

    let second_notification =
        tokio::time::timeout(Duration::from_millis(100), receiver.recv()).await;
    assert!(second_notification.is_ok(), "Expected second notification");

    // No third notification expected
    let third_notification =
        tokio::time::timeout(Duration::from_millis(100), receiver.recv()).await;
    assert!(
        third_notification.is_err(),
        "Did not expect third notification"
    );

    // Only 2 payloads should be in the queue (payload1 and payload3)
    assert_eq!(queue.len().await, 2);
}

#[tokio::test]
async fn test_notification_optimization_with_rapid_pushes() {
    let db = tmp_db();
    let (sender, mut receiver) = mpsc::channel(1);
    let queue = BuildingStageQueue::new();
    let loader = PayloadDbLoader::new(db, sender, queue.clone(), "test_domain".to_string());

    let payloads: Vec<_> = (0..5).map(|_| FullPayload::random()).collect();

    // Rapidly push multiple payloads
    for payload in &payloads {
        loader.push_back(payload.clone()).await;
    }

    // Only the first push should have sent a notification (capacity was 0 after that)
    let first_notification =
        tokio::time::timeout(Duration::from_millis(100), receiver.recv()).await;
    assert!(first_notification.is_ok(), "Expected first notification");

    // No more notifications should be pending
    let second_notification =
        tokio::time::timeout(Duration::from_millis(100), receiver.recv()).await;
    assert!(
        second_notification.is_err(),
        "Expected no additional notifications"
    );

    // All payloads should be in the queue
    assert_eq!(queue.len().await, 5);
}

#[tokio::test]
async fn test_notification_with_building_stage_pattern() {
    // This test simulates the actual building stage consumption pattern
    let db = tmp_db();
    let (sender, mut receiver) = mpsc::channel(1);
    let queue = BuildingStageQueue::new();
    let loader = PayloadDbLoader::new(db, sender, queue.clone(), "test_domain".to_string());

    let payload1 = FullPayload::random();
    let payload2 = FullPayload::random();

    // Simulate building stage waiting for notification
    let building_stage_task = tokio::spawn({
        let queue = queue.clone();
        async move {
            let mut processed = Vec::new();

            // Wait for notification (like BuildingStage::run does)
            receiver
                .recv()
                .await
                .expect("Failed to receive notification");

            // Process all available payloads
            loop {
                let payloads = queue.pop_n(10).await;
                if payloads.is_empty() {
                    break;
                }
                processed.extend(payloads);
            }

            // Wait for second batch
            receiver
                .recv()
                .await
                .expect("Failed to receive second notification");
            loop {
                let payloads = queue.pop_n(10).await;
                if payloads.is_empty() {
                    break;
                }
                processed.extend(payloads);
            }

            processed
        }
    });

    // Give the task time to start waiting
    tokio::time::sleep(Duration::from_millis(10)).await;

    // Push first payload
    loader.push_back(payload1.clone()).await;

    // Give time for processing
    tokio::time::sleep(Duration::from_millis(50)).await;

    // Push second payload (capacity should be restored after first was consumed)
    loader.push_back(payload2.clone()).await;

    // Wait for completion
    let processed = tokio::time::timeout(Duration::from_millis(500), building_stage_task)
        .await
        .expect("Timeout waiting for building stage task")
        .expect("Building stage task failed");

    assert_eq!(processed.len(), 2);
    assert_eq!(processed[0], payload1);
    assert_eq!(processed[1], payload2);
    assert_eq!(queue.len().await, 0);
}
