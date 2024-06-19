use std::{
    cmp::Ordering,
    fmt::{Debug, Display},
    time::{Duration, Instant},
};

use crate::{
    ChainResult, FixedPointNumber, HyperlaneDomain, HyperlaneMessage, TryBatchAs, TxOutcome, H256,
    U256,
};
use async_trait::async_trait;
use num::CheckedDiv;
use strum::Display;
use tracing::warn;

/// Boxed operation that can be stored in an operation queue
pub type QueueOperation = Box<dyn PendingOperation>;

/// A pending operation that will be run by the submitter and cause a
/// transaction to be sent.
///
/// There are three stages to the lifecycle of a pending operation:
///
/// 1) Prepare: This is called before every submission and will usually have a
/// very short gap between it and the submit call. It can be used to confirm it
/// is ready to be submitted and it can also prepare any data that will be
/// needed for the submission. This way, the preparation can be done while
/// another transaction is being submitted.
///
/// 2) Submit: This is called to submit the operation to the destination
/// blockchain and report if it was successful or not. This is usually the act
/// of submitting a transaction. Ideally this step only sends the transaction
/// and waits for it to be included.
///
/// 3) Confirm: This is called after the operation has been submitted and is
/// responsible for checking if the operation has reached a point at which we
/// consider it safe from reorgs.
#[async_trait]
pub trait PendingOperation: Send + Sync + Debug + TryBatchAs<HyperlaneMessage> {
    /// Get the unique identifier for this operation.
    fn id(&self) -> H256;

    /// A lower value means a higher priority, such as the message nonce
    /// As new types of PendingOperations are added, an idea is to just use the
    /// current length of the queue as this item's priority.
    /// Overall this method isn't critical, since it's only used to compare
    /// operations when neither of them have a `next_attempt_after`
    fn priority(&self) -> u32;

    /// The domain this originates from.
    fn origin_domain_id(&self) -> u32;

    /// The domain this operation will take place on.
    fn destination_domain(&self) -> &HyperlaneDomain;

    /// Label to use for metrics granularity.
    fn app_context(&self) -> Option<String>;

    /// The status of the operation, which should explain why it is in the
    /// queue.
    fn status(&self) -> PendingOperationStatus;

    fn set_status(&mut self, status: PendingOperationStatus);

    /// Get tuple of labels for metrics.
    fn get_operation_labels(&self) -> (String, String) {
        let app_context = self.app_context().unwrap_or("Unknown".to_string());
        let destination = self.destination_domain().to_string();
        (destination, app_context)
    }

    /// Prepare to submit this operation. This will be called before every
    /// submission and will usually have a very short gap between it and the
    /// submit call.
    async fn prepare(&mut self) -> PendingOperationResult;

    /// Submit this operation to the blockchain
    async fn submit(&mut self);

    /// Set the outcome of the `submit` call
    fn set_submission_outcome(&mut self, outcome: TxOutcome);

    /// Get the estimated the cost of the `submit` call
    fn get_tx_cost_estimate(&self) -> Option<U256>;

    /// This will be called after the operation has been submitted and is
    /// responsible for checking if the operation has reached a point at
    /// which we consider it safe from reorgs.
    async fn confirm(&mut self) -> PendingOperationResult;

    /// Record the outcome of the operation
    fn set_operation_outcome(
        &mut self,
        submission_outcome: TxOutcome,
        submission_estimated_cost: U256,
    );

    /// Get the earliest instant at which this should next be attempted.
    ///
    /// This is only used for sorting, the functions are responsible for
    /// returning `NotReady` if it is too early and matters.
    fn next_attempt_after(&self) -> Option<Instant>;

    /// Set the next time this operation should be attempted.
    fn set_next_attempt_after(&mut self, delay: Duration);

    /// Reset the number of attempts this operation has made, causing it to be
    /// retried immediately.
    fn reset_attempts(&mut self);

    /// Set the number of times this operation has been retried.
    #[cfg(any(test, feature = "test-utils"))]
    fn set_retries(&mut self, retries: u32);
}

#[derive(Debug, Display, Clone)]
pub enum PendingOperationStatus {
    FirstPrepareAttempt,
    Retry(String),
    ReadyToSubmit,
    SubmittedBySelf,
    AlreadySubmitted,
}

/// Utility fn to calculate the total estimated cost of an operation batch
pub fn total_estimated_cost(ops: &[Box<dyn PendingOperation>]) -> U256 {
    ops.iter()
        .fold(U256::zero(), |acc, op| match op.get_tx_cost_estimate() {
            Some(cost_estimate) => acc.saturating_add(cost_estimate),
            None => {
                warn!(operation=?op, "No cost estimate available for operation, defaulting to 0");
                acc
            }
        })
}

/// Calculate the gas used by an operation (either in a batch or single-submission), by looking at the total cost of the tx,
/// and the estimated cost of the operation compared to the sum of the estimates of all operations in the batch.
/// When using this for single-submission rather than a batch,
/// the `tx_estimated_cost` should be the same as the `tx_estimated_cost`
pub fn gas_used_by_operation(
    tx_outcome: &TxOutcome,
    tx_estimated_cost: U256,
    operation_estimated_cost: U256,
) -> ChainResult<U256> {
    let gas_used_by_tx = FixedPointNumber::try_from(tx_outcome.gas_used)?;
    let operation_gas_estimate = FixedPointNumber::try_from(operation_estimated_cost)?;
    let tx_gas_estimate = FixedPointNumber::try_from(tx_estimated_cost)?;
    let gas_used_by_operation = (gas_used_by_tx * operation_gas_estimate)
        .checked_div(&tx_gas_estimate)
        .ok_or(eyre::eyre!("Division by zero"))?;
    gas_used_by_operation.try_into()
}

impl Display for QueueOperation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "QueueOperation(id: {}, origin: {}, destination: {}, priority: {})",
            self.id(),
            self.origin_domain_id(),
            self.destination_domain(),
            self.priority()
        )
    }
}

impl PartialOrd for QueueOperation {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl PartialEq for QueueOperation {
    fn eq(&self, other: &Self) -> bool {
        self.id().eq(&other.id())
    }
}

impl Eq for QueueOperation {}

impl Ord for QueueOperation {
    fn cmp(&self, other: &Self) -> Ordering {
        use Ordering::*;
        match (self.next_attempt_after(), other.next_attempt_after()) {
            (Some(a), Some(b)) => a.cmp(&b),
            // No time means it should come before
            (None, Some(_)) => Less,
            (Some(_), None) => Greater,
            (None, None) => {
                if self.origin_domain_id() == other.origin_domain_id() {
                    // Should execute in order of nonce for the same origin
                    self.priority().cmp(&other.priority())
                } else {
                    // There is no priority between these messages, so arbitrarily use the id
                    self.id().cmp(&other.id())
                }
            }
        }
    }
}

/// Possible outcomes of performing an action on a pending operation (such as `prepare`, `submit` or `confirm`).
#[derive(Debug)]
pub enum PendingOperationResult {
    /// Promote to the next step
    Success,
    /// This operation is not ready to be attempted again yet
    NotReady,
    /// Operation needs to be started from scratch again
    Reprepare(String),
    /// Do not attempt to run the operation again, forget about it
    Drop,
    /// Send this message straight to the confirm queue
    Confirm,
}

/// create a `op_try!` macro for the `on_retry` handler.
#[macro_export]
macro_rules! make_op_try {
    ($on_retry:expr) => {
        /// Handle a result and either return early with retry or a critical failure on
        /// error.
        macro_rules! op_try {
                            (critical: $e:expr, $ctx:literal) => {
                                match $e {
                                    Ok(v) => v,
                                    Err(e) => {
                                        error!(error=?e, concat!("Critical error when ", $ctx));
                                        #[allow(clippy::redundant_closure_call)]
                                        return $on_retry();
                                    }
                                }
                            };
                            ($e:expr, $ctx:literal) => {
                                match $e {
                                    Ok(v) => v,
                                    Err(e) => {
                                        warn!(error=?e, concat!("Error when ", $ctx));
                                        #[allow(clippy::redundant_closure_call)]
                                        return $on_retry();
                                    }
                                }
                            };
                        }
    };
}
