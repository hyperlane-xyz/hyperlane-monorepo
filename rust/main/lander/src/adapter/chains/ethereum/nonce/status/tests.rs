use crate::adapter::chains::ethereum::nonce::NonceManager;
use crate::transaction::TransactionUuid;
use crate::{TransactionDropReason, TransactionStatus};

use super::NonceStatus;

#[test]
fn test_calculate_nonce_status_pending_inclusion() {
    let uuid = TransactionUuid::random();
    let status = TransactionStatus::PendingInclusion;
    let result = NonceStatus::calculate_nonce_status(uuid, &status);
    assert!(matches!(result, NonceStatus::Taken(_)));
}

#[test]
fn test_calculate_nonce_status_mempool() {
    let uuid = TransactionUuid::random();
    let status = TransactionStatus::Mempool;
    let result = NonceStatus::calculate_nonce_status(uuid, &status);
    assert!(matches!(result, NonceStatus::Taken(_)));
}

#[test]
fn test_calculate_nonce_status_included() {
    let uuid = TransactionUuid::random();
    let status = TransactionStatus::Included;
    let result = NonceStatus::calculate_nonce_status(uuid, &status);
    assert!(matches!(result, NonceStatus::Taken(_)));
}

#[test]
fn test_calculate_nonce_status_finalized() {
    let uuid = TransactionUuid::random();
    let status = TransactionStatus::Finalized;
    let result = NonceStatus::calculate_nonce_status(uuid, &status);
    assert!(matches!(result, NonceStatus::Committed(_)));
}

#[test]
fn test_calculate_nonce_status_dropped() {
    let uuid = TransactionUuid::random();
    let status = TransactionStatus::Dropped(TransactionDropReason::DroppedByChain);
    let result = NonceStatus::calculate_nonce_status(uuid, &status);
    assert!(matches!(result, NonceStatus::Freed(_)));
}
