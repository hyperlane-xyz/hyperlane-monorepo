use std::sync::Arc;

use tracing::warn;

use hyperlane_base::db::HyperlaneDb;
use hyperlane_core::QueueOperation;
use lander::{Entrypoint, PayloadStatus, TransactionStatus};

/// Disposition for routing operations through the message processor pipeline.
///
/// This enum determines how operations should be handled across the three-stage
/// message processing pipeline (Prepare → Submit → Confirm).
///
/// # Stage-specific behavior
///
/// ## Prepare Stage
/// When `filter_operations_for_preparation` evaluates an operation:
/// - `PreSubmit`: Returned to caller for preparation (metadata fetch, gas estimation, payload creation)
/// - `Submit`: Pushed to submit queue with `ReadyToSubmit` status (payload already exists)
/// - `PostSubmit`: Pushed to confirm queue with `Confirm(AlreadySubmitted)` status (already on-chain)
///
/// ## Submit Stage
/// When `filter_operations_for_submit` evaluates an operation:
/// - `PreSubmit`: Returned to caller for immediate payload creation and submission (failed/dropped payload)
/// - `Submit`: Re-queued to submit queue with `ReadyToSubmit` status (waiting for blockchain inclusion)
/// - `PostSubmit`: Moved to confirm queue via `confirm_op` (transaction included in block)
///
/// ## Confirm Stage
/// The confirm stage does not use disposition logic - it directly processes operations
/// to verify finality and commit delivery status to the database.
pub enum OperationDisposition {
    /// Operation requires preparation or has failed submission.
    ///
    /// Indicates that:
    /// - No payload exists for this operation (new message)
    /// - Payload was dropped or reverted (needs retry)
    /// - Payload requires retry due to reorg
    /// - Cannot determine payload status (DB/RPC error - assume needs preparation)
    ///
    /// **Prepare stage**: Returns operation to caller for preparation (metadata, gas, payload)
    /// **Submit stage**: Returns operation to caller for immediate payload creation and submission
    PreSubmit,

    /// Operation is actively in the submission pipeline.
    ///
    /// Indicates that:
    /// - Payload exists and is ready to submit (`ReadyToSubmit`)
    /// - Transaction is pending blockchain inclusion (`PendingInclusion`)
    /// - Transaction is in mempool (`Mempool`)
    ///
    /// **Prepare stage**: Pushes to submit queue (payload already exists, skip preparation)
    /// **Submit stage**: Re-queues to submit queue (waiting for inclusion, check again later)
    Submit,

    /// Operation has been included in a block.
    ///
    /// Indicates that:
    /// - Transaction has been included in a block (`Included`)
    /// - Transaction has been finalized (`Finalized`)
    ///
    /// **Prepare stage**: Pushes to confirm queue with `AlreadySubmitted` reason
    /// **Submit stage**: Moves to confirm queue for finality verification
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
        Err(e) => {
            warn!("Failed to retrieve payload uuids by message id: message_id={id:?}, error={e:?}");
            return PreSubmit;
        }
    };

    let payload_uuids = match payload_uuids {
        None => return PreSubmit,
        Some(uuids) if uuids.is_empty() => return PreSubmit,
        Some(uuids) => uuids,
    };

    // checking only the first payload uuid since we support a single payload per message at this point
    let payload_uuid = payload_uuids[0].clone();
    let status = match entrypoint.payload_status(payload_uuid.clone()).await {
        Ok(status) => status,
        Err(e) => {
            warn!("Failed to retrieve payload status by its uuid: message_id={id:?}, payload_uuid={payload_uuid:?}, error={e:?}");
            return PreSubmit;
        }
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
