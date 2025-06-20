use crate::payload::FullPayload;

use super::super::queue::BuildingStageQueue;

#[tokio::test]
async fn test_push_and_pop_back_and_front() {
    let queue = BuildingStageQueue::new();
    let payload1 = FullPayload::random();
    let payload2 = FullPayload::random();

    queue.push_back(payload1.clone()).await;
    queue.push_front(payload2.clone()).await;

    // payload2 should be at the front
    let popped = queue.pop_n(1).await;
    assert_eq!(popped.len(), 1);
    assert_eq!(popped[0], payload2);

    // payload1 should be next
    let popped = queue.pop_n(1).await;
    assert_eq!(popped.len(), 1);
    assert_eq!(popped[0], payload1);

    // queue should be empty now
    assert_eq!(queue.len().await, 0);
}

#[tokio::test]
async fn test_extend_and_len() {
    let queue = BuildingStageQueue::new();
    let payloads: Vec<_> = (0..5).map(|_| FullPayload::random()).collect();
    queue.extend(payloads.clone()).await;
    assert_eq!(queue.len().await, 5);

    let popped = queue.pop_n(5).await;
    assert_eq!(popped, payloads);
    assert_eq!(queue.len().await, 0);
}

#[tokio::test]
async fn test_pop_n_partial_and_empty() {
    let queue = BuildingStageQueue::new();
    let payloads: Vec<_> = (0..3).map(|_| FullPayload::random()).collect();
    queue.extend(payloads.clone()).await;

    // Try to pop more than available
    let popped = queue.pop_n(5).await;
    assert_eq!(popped, payloads);
    assert_eq!(queue.len().await, 0);

    // Pop from an empty queue
    let popped = queue.pop_n(1).await;
    assert!(popped.is_empty());
}

#[tokio::test]
async fn test_order_is_preserved() {
    let queue = BuildingStageQueue::new();
    let payloads: Vec<_> = (0..10).map(|_| FullPayload::random()).collect();
    for payload in &payloads {
        queue.push_back(payload.clone()).await;
    }
    let popped = queue.pop_n(10).await;
    assert_eq!(popped, payloads);
}

#[tokio::test]
async fn test_len_is_correct_after_operations() {
    let queue = BuildingStageQueue::new();
    assert_eq!(queue.len().await, 0);

    let payload1 = FullPayload::random();
    let payload2 = FullPayload::random();

    queue.push_back(payload1.clone()).await;
    assert_eq!(queue.len().await, 1);

    queue.push_front(payload2.clone()).await;
    assert_eq!(queue.len().await, 2);

    let _ = queue.pop_n(1).await;
    assert_eq!(queue.len().await, 1);

    let _ = queue.pop_n(1).await;
    assert_eq!(queue.len().await, 0);
}
