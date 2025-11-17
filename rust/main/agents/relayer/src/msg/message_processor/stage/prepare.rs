use std::sync::Arc;

use tracing::warn;

use hyperlane_base::db::HyperlaneDb;
use hyperlane_core::ConfirmReason::AlreadySubmitted;
use hyperlane_core::PendingOperationStatus::{Confirm, ReadyToSubmit, Retry};
use hyperlane_core::{QueueOperation, ReprepareReason};
use lander::Entrypoint;

use crate::msg::message_processor::disposition;
use crate::msg::message_processor::disposition::OperationDisposition;
use crate::msg::op_queue::OpQueue;

/// Filters operations from a batch to determine which should proceed to preparation.
///
/// Operations are routed based on their disposition:
/// - PreSubmit: Returned for preparation
/// - Submit: Pushed to submit queue
/// - PostSubmit: Pushed to confirmation queue
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
    use OperationDisposition::{PostSubmit, PreSubmit, Submit};

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
            PostSubmit => {
                let status = Some(Confirm(AlreadySubmitted));
                confirm_queue.push(op, status).await;
            }
        }
    }

    ops_to_prepare
}

async fn determine_operation_disposition(
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
        let message_id = op.id();
        if let Err(e) = db.store_payload_uuids_by_message_id(&message_id, vec![]) {
            warn!(
                ?e,
                ?message_id,
                "Failed to remove payload UUID mapping for manual operation"
            );
        }
    }

    // Determine disposition based on payload status
    disposition::operation_disposition_by_payload_status(entrypoint, db, op).await
}

#[cfg(test)]
mod tests;
