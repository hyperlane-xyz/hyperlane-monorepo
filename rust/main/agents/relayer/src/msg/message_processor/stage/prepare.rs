use std::sync::Arc;

use tracing::warn;

use hyperlane_base::db::HyperlaneDb;
use hyperlane_core::ConfirmReason::AlreadySubmitted;
use hyperlane_core::PendingOperationStatus::{Confirm, Retry};
use hyperlane_core::{QueueOperation, ReprepareReason};
use lander::Entrypoint;

use crate::msg::message_processor::disposition;
use crate::msg::message_processor::disposition::OperationDisposition;
use crate::msg::op_queue::OpQueue;

/// Filters operations from a batch to determine which should proceed to preparation.
///
/// Operations already submitted (and not dropped) are pushed to the confirmation queue.
/// Operations that need preparation are returned for further processing.
///
/// # Returns
/// A vector of operations that should proceed to the preparation phase.
pub(crate) async fn filter_operations_for_preparation(
    entrypoint: Arc<dyn Entrypoint + Send + Sync>,
    confirm_queue: &OpQueue,
    db: Arc<dyn HyperlaneDb>,
    batch: Vec<QueueOperation>,
) -> Vec<QueueOperation> {
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
            OperationDisposition::PreSubmit => {
                ops_to_prepare.push(op);
            }
            OperationDisposition::PostSubmit => {
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
