use super::super::core::tests::{create_test_adapter, create_test_transaction};

#[test]
fn test_tx_ready_for_resubmission() {
    let adapter = create_test_adapter();

    // Test 1: Transaction never submitted - should be ready immediately
    let mut tx = create_test_transaction();
    assert_eq!(tx.last_submission_attempt, None);
    let result = adapter.ready_for_resubmission(&tx);
    assert!(
        result,
        "Transaction with no previous submission should be ready"
    );

    // Test 2: Transaction submitted recently - should NOT be ready
    tx.last_submission_attempt = Some(chrono::Utc::now());
    let result = adapter.ready_for_resubmission(&tx);
    assert!(
        !result,
        "Transaction submitted recently should not be ready"
    );

    // Test 3: Transaction submitted long ago - should be ready
    let old_time = chrono::Utc::now() - chrono::Duration::seconds(20);
    tx.last_submission_attempt = Some(old_time);
    let result = adapter.ready_for_resubmission(&tx);
    assert!(
        result,
        "Transaction submitted 20 seconds ago (> 10s block time) should be ready"
    );

    // Test 4: Transaction with future submission time (negative duration edge case)
    // This tests the .unwrap_or(block_time) fallback when to_std() fails
    let future_time = chrono::Utc::now() + chrono::Duration::seconds(5);
    tx.last_submission_attempt = Some(future_time);
    let result = adapter.ready_for_resubmission(&tx);
    assert!(
        result,
        "Transaction with future submission time should be ready (safety fallback)"
    );
}
