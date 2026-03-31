use std::time::Duration;

use crate::adapter::AdaptsChain;

use super::super::TransactionFactory;
use super::tests_common::{adapter, payload, precursor};

#[tokio::test]
async fn test_submit() {
    // given
    let adapter = adapter();
    let mut transaction = TransactionFactory::build(precursor(), &payload());

    // when
    let result = adapter.submit(&mut transaction).await;

    // then
    assert!(result.is_ok());
}

#[tokio::test]
async fn test_ready_for_resubmission() {
    // given
    let adapter = adapter();
    let mut transaction = TransactionFactory::build(precursor(), &payload());

    let expected_resubmission_time = adapter.time_before_resubmission();

    let now = chrono::Utc::now();
    let recent_but_too_soon_for_resubmission =
        now - expected_resubmission_time + Duration::from_millis(1);
    let recent_but_ready_for_resubmission = now - expected_resubmission_time;

    // when
    transaction.last_submission_attempt = Some(recent_but_too_soon_for_resubmission);
    let is_ready = adapter.tx_ready_for_resubmission(&transaction).await;
    assert!(!is_ready);

    transaction.last_submission_attempt = Some(recent_but_ready_for_resubmission);
    let is_ready = adapter.tx_ready_for_resubmission(&transaction).await;
    assert!(is_ready);
}

#[tokio::test]
async fn test_time_before_resubmission() {
    let mut adapter = adapter();
    // the block time of SOON SVM is 50ms
    adapter.estimated_block_time = Duration::from_millis(50);

    let expected_time_before_resubmission = adapter.estimated_block_time.mul_f32(3.0);

    assert_eq!(
        adapter.time_before_resubmission(),
        expected_time_before_resubmission
    );
}
