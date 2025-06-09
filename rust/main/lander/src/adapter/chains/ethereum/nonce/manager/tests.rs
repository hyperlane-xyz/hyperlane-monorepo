use crate::transaction::{TransactionStatus, TransactionUuid};
use crate::TransactionDropReason;

use super::super::manager::NonceManager;
use super::super::state::NonceStatus;

#[test]
fn test_calculate_nonce_status_pending_inclusion() {
    let uuid = TransactionUuid::random();
    let status = TransactionStatus::PendingInclusion;
    let result = NonceManager::calculate_nonce_status(uuid, &status);
    assert!(matches!(result, NonceStatus::Taken(_)));
}

#[test]
fn test_calculate_nonce_status_mempool() {
    let uuid = TransactionUuid::random();
    let status = TransactionStatus::Mempool;
    let result = NonceManager::calculate_nonce_status(uuid, &status);
    assert!(matches!(result, NonceStatus::Taken(_)));
}

#[test]
fn test_calculate_nonce_status_included() {
    let uuid = TransactionUuid::random();
    let status = TransactionStatus::Included;
    let result = NonceManager::calculate_nonce_status(uuid, &status);
    assert!(matches!(result, NonceStatus::Placed(_)));
}

#[test]
fn test_calculate_nonce_status_finalized() {
    let uuid = TransactionUuid::random();
    let status = TransactionStatus::Finalized;
    let result = NonceManager::calculate_nonce_status(uuid, &status);
    assert!(matches!(result, NonceStatus::Committed(_)));
}

#[test]
fn test_calculate_nonce_status_dropped() {
    let uuid = TransactionUuid::random();
    let status = TransactionStatus::Dropped(TransactionDropReason::DroppedByChain);
    let result = NonceManager::calculate_nonce_status(uuid, &status);
    assert!(matches!(result, NonceStatus::Freed(_)));
}
