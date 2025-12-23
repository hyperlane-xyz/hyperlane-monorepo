use tracing::error;

use hyperlane_aleo::AleoTxData;

use crate::adapter::chains::aleo::transaction::TransactionFactory;
use crate::{
    adapter::{chains::aleo::AleoTxPrecursor, TxBuildingResult},
    transaction::Transaction,
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
    serde_json::from_slice::<AleoTxData>(&full_payload.data)
        .map_err(|err| {
            error!(?err, "Failed to deserialize AleoTxData");
            err
        })
        .ok()
        .map(|operation_payload| create_transaction(operation_payload, full_payload))
}

/// Creates a transaction from deserialized tx data using the type-safe generic builder
fn create_transaction(operation_payload: AleoTxData, full_payload: &FullPayload) -> Transaction {
    let precursor = AleoTxPrecursor::from(operation_payload);
    TransactionFactory::build(precursor, full_payload)
}

#[cfg(test)]
mod tests;
