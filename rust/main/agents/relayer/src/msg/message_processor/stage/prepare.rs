use std::sync::Arc;

use tracing::warn;

use hyperlane_base::db::HyperlaneDb;
use hyperlane_core::ConfirmReason::AlreadySubmitted;
use hyperlane_core::PendingOperationStatus::{Confirm, ReadyToSubmit, Retry};
use hyperlane_core::{QueueOperation, ReprepareReason};
use lander::Entrypoint;

use crate::msg::op_queue::OpQueue;

use super::super::disposition::{operation_disposition_by_payload_status, OperationDisposition};

/// Filters operations from a batch to determine which should proceed to preparation.
///
/// This function determines the disposition of each operation and routes them accordingly:
/// - `PreSubmit`: Operations returned for preparation (new messages or messages needing retry)
/// - `Submit`: Operations pushed to submit queue (ready for submission or in submission pipeline)
/// - `PostSubmitSuccess`: Operations pushed to confirm queue (successfully submitted, awaiting confirmation)
/// - `PostSubmitFailure`: Operations with dropped/failed transactions have their linkage removed and are returned for re-preparation
///
/// # Arguments
/// * `entrypoint` - The lander entrypoint for checking payload status
/// * `submit_queue` - Queue for operations ready to be submitted
/// * `confirm_queue` - Queue for operations awaiting confirmation
/// * `db` - Database for managing message-payload linkages
/// * `batch` - Vector of operations to filter
///
/// # Returns
/// A vector of operations that should proceed to the preparation phase.
pub(crate) async fn filter_operations_for_preparation(
    entrypoint: Arc<dyn Entrypoint + Send + Sync>,
    submit_queue: &OpQueue,
    confirm_queue: &OpQueue,
    db: Arc<dyn HyperlaneDb>,
    batch: Vec<QueueOperation>,
) -> Vec<QueueOperation> {
    use OperationDisposition::{PostSubmitFailure, PostSubmitSuccess, PreSubmit, Submit};

    // Phase 1: Determine disposition for each operation
    let mut operations_with_disposition = Vec::with_capacity(batch.len());
    for op in batch {
        let disposition =
            determine_operation_disposition(entrypoint.clone(), db.clone(), &op).await;
        operations_with_disposition.push((op, disposition));
    }

    // Phase 2: Process operations based on their disposition
    let mut ops_to_prepare = Vec::new();
    for (op, disposition) in operations_with_disposition {
        match disposition {
            PreSubmit => {
                ops_to_prepare.push(op);
            }
            Submit => {
                // We are not differentiating operations which arrived to Submit queue
                // for the first time and operations which stuck there at the moment.
                // Depending on type of failures with submission, we can add more variants of
                // PendingOperationStatus which will allow to identify the root cause quicker.
                submit_queue.push(op, Some(ReadyToSubmit)).await;
            }
            PostSubmitSuccess => {
                let status = Some(Confirm(AlreadySubmitted));
                confirm_queue.push(op, status).await;
            }
            PostSubmitFailure => {
                // Remove link between message and payload for PostSubmitFailure disposition
                // so that Prepare stage and Submit stage can reprocess the message
                remove_linkage_between_payload_and_message(&db, &op);
                ops_to_prepare.push(op);
            }
        }
    }

    ops_to_prepare
}

/// Determines the disposition of an operation based on its status and payload state.
///
/// This function serves as the central decision point for routing operations in the prepare stage.
/// For manual retry operations, it first removes the message-payload linkage to enable fresh
/// re-processing regardless of the payload's current state. It then delegates to
/// `operation_disposition_by_payload_status` to determine the actual disposition based on the
/// payload's state in lander (transaction submitted, dropped, confirmed, etc.).
///
/// # Arguments
/// * `entrypoint` - The lander entrypoint for checking payload status
/// * `db` - Database for managing message-payload linkages
/// * `op` - The queue operation to evaluate
///
/// # Returns
/// The determined `OperationDisposition` indicating how the operation should be routed:
/// - `PreSubmit`: Operation needs preparation (new message or failed/dropped transaction)
/// - `Submit`: Operation ready for submission or in submission pipeline
/// - `PostSubmitSuccess`: Operation successfully submitted, awaiting confirmation
/// - `PostSubmitFailure`: Operation's transaction dropped/failed, needs re-preparation after confirmation attempt
pub(crate) async fn determine_operation_disposition(
    entrypoint: Arc<dyn Entrypoint + Send + Sync>,
    db: Arc<dyn HyperlaneDb>,
    op: &QueueOperation,
) -> OperationDisposition {
    // Check if operation requires manual intervention
    if let Retry(ReprepareReason::Manual) = op.status() {
        // Remove link between message and payload for Manual operations
        // to allow re-processing even if payload status filtering is
        // applied in other stages (submit, confirm)
        // Once this linkage is removed, operation disposition will be PreSubmit
        remove_linkage_between_payload_and_message(&db, op);
    }

    // Determine disposition based on payload status
    operation_disposition_by_payload_status(entrypoint, db, op).await
}

/// Removes the linkage between a message and its associated payload UUIDs.
///
/// This function is critical for enabling message re-processing by clearing the database
/// mapping between a message ID and its payload UUIDs. When a payload drops, is reorged,
/// or requires manual intervention, removing this linkage allows the prepare stage to
/// create a new payload for the message.
///
/// Use cases:
/// - Manual retry operations (user-requested re-processing)
/// - PostSubmitFailure disposition (transaction dropped after submission)
/// - Reorged payloads (transaction lost due to chain reorganization)
///
/// # Error Handling
/// If the database operation fails, a warning is logged but the error is not propagated.
/// This ensures that transient database issues don't block message re-processing.
///
/// # Arguments
/// * `db` - Database handle for storing payload UUID mappings
/// * `op` - The queue operation whose linkage should be removed
fn remove_linkage_between_payload_and_message(db: &Arc<dyn HyperlaneDb>, op: &QueueOperation) {
    let message_id = op.id();
    if let Err(e) = db.store_payload_uuids_by_message_id(&message_id, vec![]) {
        warn!(
            ?e,
            ?message_id,
            "Failed to remove payload UUID mapping for manual operation"
        );
    }
}

#[cfg(test)]
mod tests;
