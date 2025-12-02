use tracing::error;
use uuid::Uuid;

use hyperlane_aleo::AleoTxCalldata;

use crate::{
    adapter::{chains::aleo::AleoTxPrecursor, TxBuildingResult},
    transaction::{Transaction, TransactionStatus, TransactionUuid, VmSpecificTxData},
    FullPayload,
};

/// Builds a single transaction from a payload
pub(super) fn build_transaction_from_payload(full_payload: &FullPayload) -> TxBuildingResult {
    let maybe_tx = deserialize_and_create_transaction(full_payload);
    TxBuildingResult {
        payloads: vec![full_payload.details.clone()],
        maybe_tx,
    }
}

/// Deserializes payload data and creates a transaction
fn deserialize_and_create_transaction(full_payload: &FullPayload) -> Option<Transaction> {
    serde_json::from_slice::<AleoTxCalldata>(&full_payload.data)
        .ok()
        .map(|operation_payload| create_transaction(operation_payload, full_payload))
}

/// Creates a transaction from deserialized calldata
fn create_transaction(
    operation_payload: AleoTxCalldata,
    full_payload: &FullPayload,
) -> Transaction {
    let precursor = AleoTxPrecursor::from(operation_payload);
    Transaction {
        uuid: TransactionUuid::new(Uuid::new_v4()),
        tx_hashes: vec![],
        vm_specific_data: VmSpecificTxData::Aleo(Box::new(precursor)),
        payload_details: vec![full_payload.details.clone()],
        status: TransactionStatus::PendingInclusion,
        submission_attempts: 0,
        creation_timestamp: chrono::Utc::now(),
        last_submission_attempt: None,
        last_status_check: None,
    }
}

#[cfg(test)]
mod tests;
