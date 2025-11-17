use std::sync::Arc;

use hyperlane_base::db::HyperlaneDb;
use hyperlane_core::PendingOperationStatus::ReadyToSubmit;
use hyperlane_core::QueueOperation;
use lander::Entrypoint;

use crate::msg::message_processor::disposition::OperationDisposition;
use crate::msg::message_processor::{confirm_op, disposition, MessageProcessorMetrics};
use crate::msg::op_queue::OpQueue;

/// Filters operations from the Submit queue to determine their next stage.
///
/// Operations are routed based on their disposition:
/// - PreSubmit: Payload failed/dropped, return for immediate resubmission
/// - Submit: Payload still in submission pipeline, re-queue to submit queue
/// - PostSubmit: Payload included/finalized, move to confirm queue
///
/// # Returns
/// A vector of operations with PreSubmit disposition that need immediate payload resubmission.
/// Other operations are routed to their appropriate queues internally.
pub(crate) async fn filter_operations_for_submit(
    entrypoint: Arc<dyn Entrypoint + Send + Sync>,
    submit_queue: &OpQueue,
    confirm_queue: &OpQueue,
    metrics: &MessageProcessorMetrics,
    db: Arc<dyn HyperlaneDb>,
    batch: Vec<QueueOperation>,
) -> Vec<QueueOperation> {
    use OperationDisposition::{PostSubmit, PreSubmit, Submit};

    // Phase 1: Determine disposition for each operation
    let mut operations_with_disposition = Vec::with_capacity(batch.len());
    for op in batch {
        let disposition = disposition::operation_disposition_by_payload_status(
            entrypoint.clone(),
            db.clone(),
            &op,
        )
        .await;
        operations_with_disposition.push((op, disposition));
    }

    // Phase 2: Process operations based on their disposition
    let mut ops_to_submit = Vec::new();
    for (op, disposition) in operations_with_disposition {
        match disposition {
            PreSubmit => {
                ops_to_submit.push(op);
            }
            Submit => {
                submit_queue.push(op, Some(ReadyToSubmit)).await;
            }
            PostSubmit => {
                // Payload has been included, move to confirm queue
                confirm_op(op, confirm_queue, metrics).await;
            }
        }
    }

    ops_to_submit
}

#[cfg(test)]
mod tests;
