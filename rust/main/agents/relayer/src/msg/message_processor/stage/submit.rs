use std::sync::Arc;

use hyperlane_base::db::HyperlaneDb;
use hyperlane_core::PendingOperationStatus::ReadyToSubmit;
use hyperlane_core::QueueOperation;
use lander::Entrypoint;
use tracing::warn;

use crate::msg::op_queue::OpQueue;

use super::super::disposition::{operation_disposition_by_payload_status, OperationDisposition};
use super::super::{confirm_op, MessageProcessorMetrics};

/// Filters operations from the Submit queue to determine their next stage.
///
/// This function determines the disposition of each operation and routes them accordingly:
/// - `PreSubmit`: Operations returned for immediate resubmission (payload failed/dropped before submission)
/// - `Submit`: Operations re-queued to submit queue (still in submission pipeline: ReadyToSubmit, PendingInclusion, Mempool)
/// - `PostSubmitSuccess`: Operations moved to confirm queue (transaction included/finalized in block)
/// - `PostSubmitFailure`: Operations moved to confirm queue (transaction dropped after submission)
///
/// # Critical PostSubmitFailure Handling
/// Both `PostSubmitSuccess` and `PostSubmitFailure` are routed to the Confirm stage to verify
/// message delivery status. For `PostSubmitFailure`, this prevents infinite loops by ensuring
/// the message wasn't actually delivered before returning to the prepare stage for re-preparation.
/// The Confirm stage will verify non-delivery and then route back to prepare with linkage removed.
///
/// # Arguments
/// * `entrypoint` - The lander entrypoint for checking payload status
/// * `submit_queue` - Queue for operations in submission pipeline
/// * `confirm_queue` - Queue for operations awaiting confirmation
/// * `metrics` - Message processor metrics for tracking
/// * `db` - Database for retrieving payload UUID mappings
/// * `batch` - Vector of operations to filter
///
/// # Returns
/// A vector of operations with `PreSubmit` disposition that need immediate payload resubmission.
/// Other operations are routed to their appropriate queues internally.
pub(crate) async fn filter_operations_for_submit(
    entrypoint: Arc<dyn Entrypoint + Send + Sync>,
    submit_queue: &OpQueue,
    confirm_queue: &OpQueue,
    metrics: &MessageProcessorMetrics,
    db: Arc<dyn HyperlaneDb>,
    batch: Vec<QueueOperation>,
) -> Vec<QueueOperation> {
    use OperationDisposition::{PostSubmitFailure, PostSubmitSuccess, PreSubmit, Submit};

    if batch.is_empty() {
        return vec![];
    }

    // Phase 1: Determine disposition for each operation
    let mut operations_with_disposition = Vec::with_capacity(batch.len());
    for op in batch {
        let disposition =
            operation_disposition_by_payload_status(entrypoint.clone(), db.clone(), &op).await;
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
                // We are not differentiating operations which arrived to Submit queue
                // for the first time and operations which stuck there at the moment.
                // Depending on type of failures with submission, we can add more variants of
                // PendingOperationStatus which will allow to identify the root cause quicker.
                submit_queue.push(op, Some(ReadyToSubmit)).await;
            }
            PostSubmitSuccess => {
                // PostSubmitSuccess is sent to Confirm stage.
                confirm_op(op, confirm_queue, metrics).await;
            }
            PostSubmitFailure => {
                // PostSubmitFailure is sent to Confirm stage so that it can check if message was
                // delivered by another means and, if not, send it back to Prepare stage
                let id = op.id();
                warn!("Failed to submit message: message_id={id:?}");
                confirm_op(op, confirm_queue, metrics).await;
            }
        }
    }

    ops_to_submit
}

#[cfg(test)]
mod tests;
