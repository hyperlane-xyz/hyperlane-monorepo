use std::sync::Arc;

use hyperlane_base::db::HyperlaneDb;
use hyperlane_core::QueueOperation;
use lander::{Entrypoint, PayloadStatus, TransactionStatus};

/// Disposition for how to handle an operation during submission check
pub enum OperationDisposition {
    /// Operation has not been submitted yet - should be prepared or submitted
    PreSubmit,
    /// Operation is in the submission pipeline - should remain in submit queue
    Submit,
    /// Operation has been submitted and included - should go to confirmation queue
    PostSubmit,
}

/// Determines the disposition of an operation based on its payload submission status.
///
/// Returns:
/// - `PreSubmit`: No payload exists, payload dropped, or cannot determine status
/// - `Submit`: Payload exists and is in submission pipeline (ReadyToSubmit, PendingInclusion, Mempool)
/// - `PostSubmit`: Payload has been included in a block (Included, Finalized)
pub(crate) async fn operation_disposition_by_payload_status(
    entrypoint: Arc<dyn Entrypoint + Send + Sync>,
    db: Arc<dyn HyperlaneDb>,
    op: &QueueOperation,
) -> OperationDisposition {
    use OperationDisposition::{PostSubmit, PreSubmit, Submit};

    let id = op.id();

    let payload_uuids = match db.retrieve_payload_uuids_by_message_id(&id) {
        Ok(uuids) => uuids,
        Err(_) => return PreSubmit,
    };

    let payload_uuids = match payload_uuids {
        None => return PreSubmit,
        Some(uuids) if uuids.is_empty() => return PreSubmit,
        Some(uuids) => uuids,
    };

    // checking only the first payload uuid since we support a single payload per message at this point
    let payload_uuid = payload_uuids[0].clone();
    let Ok(status) = entrypoint.payload_status(payload_uuid).await else {
        return PreSubmit;
    };

    match status {
        // Failed or dropped - needs re-preparation
        PayloadStatus::Dropped(_) => PreSubmit,
        PayloadStatus::InTransaction(TransactionStatus::Dropped(_)) => PreSubmit,
        PayloadStatus::Retry(_) => PreSubmit,

        // In submission pipeline - keep in Submit queue
        PayloadStatus::ReadyToSubmit => Submit,
        PayloadStatus::InTransaction(TransactionStatus::PendingInclusion) => Submit,
        PayloadStatus::InTransaction(TransactionStatus::Mempool) => Submit,

        // Included in block - move to Confirm queue
        PayloadStatus::InTransaction(TransactionStatus::Included) => PostSubmit,
        PayloadStatus::InTransaction(TransactionStatus::Finalized) => PostSubmit,
    }
}

#[cfg(test)]
mod tests;
