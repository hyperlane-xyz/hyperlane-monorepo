use std::sync::Arc;

use hyperlane_base::db::HyperlaneDb;
use hyperlane_core::QueueOperation;
use lander::Entrypoint;

/// Disposition for how to handle an operation during submission check
pub enum OperationDisposition {
    /// Operation has not been submitted yet - should be prepared or submitted
    PreSubmit,
    /// Operation has already been submitted - should go to confirmation queue
    PostSubmit,
}

/// Determines the disposition of an operation based on its payload submission status.
/// Returns PostSubmit if the payload has been submitted and is not dropped, PreSubmit otherwise.
/// If payload status cannot be determined, operation will be prepared.
pub(super) async fn operation_disposition_by_payload_status(
    entrypoint: Arc<dyn Entrypoint + Send + Sync>,
    db: Arc<dyn HyperlaneDb>,
    op: &QueueOperation,
) -> OperationDisposition {
    use lander::{PayloadStatus, TransactionStatus};
    use OperationDisposition::{PostSubmit, PreSubmit};

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

    // TODO checking only the first payload uuid since we support a single payload per message at this point
    let payload_uuid = payload_uuids[0].clone();
    let status = entrypoint.payload_status(payload_uuid).await;

    match status {
        Ok(PayloadStatus::Dropped(_)) => PreSubmit,
        Ok(PayloadStatus::InTransaction(TransactionStatus::Dropped(_))) => PreSubmit,
        Ok(_) => PostSubmit,
        Err(_) => PreSubmit,
    }
}

#[cfg(test)]
mod tests;
