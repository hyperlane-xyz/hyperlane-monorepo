use std::cmp::Ordering;
use std::time::Instant;

use async_trait::async_trait;
use enum_dispatch::enum_dispatch;
use eyre::Report;

use hyperlane_core::HyperlaneDomain;

#[allow(unused_imports)] // required for enum_dispatch
use super::pending_message::PendingMessage;

/// A pending operation that will be run by the submitter and cause a
/// transaction to be sent.
///
/// There are three stages to the lifecycle of a pending operation:
///
/// 1) Prepare: This is called before every submission and will usually have a
/// very short gap between it and the submit call. It can be used to validate it
/// is ready to be submitted and it can also prepare any data that will be
/// needed for the submission. This way, the preparation can be done while
/// another transaction is being submitted.
///
/// 2) Submit: This is called to submit the operation to the destination
/// blockchain and report if it was successful or not. This is usually the act
/// of submitting a transaction. Ideally this step only sends the transaction
/// and waits for it to be included.
///
/// 3) Validate: This is called after the operation has been submitted and is
/// responsible for checking if the operation has reached a point at which we
/// consider it safe from reorgs.
#[async_trait]
#[enum_dispatch]
pub trait PendingOperation {
    /// The domain this operation will take place on.
    fn domain(&self) -> &HyperlaneDomain;

    /// Prepare to submit this operation. This will be called before every
    /// submission and will usually have a very short gap between it and the
    /// submit call.
    async fn prepare(&mut self) -> PrepareResult;

    /// Submit this operation to the blockchain and report if it was successful
    /// or not.
    async fn submit(&mut self) -> SubmitResult;

    /// Validate this operation. This will be called after the operation has
    /// been submitted and is responsible for checking if the operation has
    /// reached a point at which we consider it safe from reorgs.
    async fn validate(&mut self) -> ValidationResult;

    fn next_attempt_after(&self) -> Option<Instant>;

    fn submitted(&self) -> bool;
}

/// A "dynamic" pending operation implementation which knows about the
/// different sub types and can properly implement PartialEq and
/// PartialOrd for them.
#[enum_dispatch(PendingOperation)]
#[derive(Debug, PartialEq, Eq)]
pub enum DynPendingOperation {
    PendingMessage,
}

impl PartialOrd for DynPendingOperation {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// Sort by their next allowed attempt time and if no allowed time is set,
/// then put it in front of those with a time (they have been tried
/// before) and break ties between ones that have not been tried with
/// the nonce.
impl Ord for DynPendingOperation {
    fn cmp(&self, other: &Self) -> Ordering {
        use DynPendingOperation::*;
        use Ordering::*;
        match (self.next_attempt_after(), other.next_attempt_after()) {
            (Some(a), Some(b)) => a.cmp(&b),
            (Some(_), None) => Greater,
            (None, Some(_)) => Less,
            (None, None) => match (self, other) {
                (PendingMessage(a), PendingMessage(b)) => a.message.nonce.cmp(&b.message.nonce),
            },
        }
    }
}

#[allow(dead_code)] // Inner types are for present _and_ future use so allow unused variants.
pub enum PrepareResult {
    /// Txn is ready to be submitted
    Ready,
    /// This Txn is not ready to be attempted again yet
    NotReady,
    /// Txn preparation failed and we should not try again or it has already
    /// been processed.
    Drop,
    /// A retry-able error occurred and we should retry after
    /// `next_attempt_after`
    Retry,
    /// Pass the error up the chain, this is non-recoverable and indicates a
    /// system failure.
    CriticalFailure(Report),
}

/// The result of running a pending transaction.
#[allow(dead_code)] // Inner types are for present _and_ future use so allow unused variants.
pub enum SubmitResult {
    /// Transaction was successfully processed
    Success,
    /// Txn failed/reverted and we should not try again
    Drop,
    /// Txn failed/reverted and we should try again after `next_attempt_after`
    Retry,
    /// Pass the error up the chain, this is non-recoverable and indicates a
    /// system failure.
    CriticalFailure(Report),
}

#[allow(dead_code)] // Inner types are for present _and_ future use so allow unused variants.
pub enum ValidationResult {
    /// Transaction was successfully validated as being included in the
    /// blockchain
    Valid,
    /// This Txn is not ready to be validated yet
    NotReady,
    /// We can't assess validity yet, check again after `next_attempt_after`
    Retry,
    /// Transaction was not included and we should re-attempt preparing and
    /// submitting it.
    Invalid,
    /// Pass the error up the chain, this is non-recoverable and indicates a
    /// system failure.
    CriticalFailure(Report),
}

/// create a `tx_try!` macro for the `on_retry` handler and the correct
/// `CriticalFailure` enum type.
macro_rules! make_tx_try {
    ($on_retry:expr, $critical_failure:path) => {
        /// Handle a result and either return early with retry or a critical failure on
        /// error.
        macro_rules! tx_try {
                                    (critical: $e:expr, $ctx:literal) => {
                                        match $e {
                                            Ok(v) => v,
                                            Err(e) => {
                                                error!(error=?e, concat!("Error when ", $ctx));
                                                return $critical_failure(
                                                    Err::<(), _>(e)
                                                        .context(concat!("When ", $ctx))
                                                        .unwrap_err()
                                                );
                                            }
                                        }
                                    };
                                    ($e:expr, $ctx:literal) => {
                                        match $e {
                                            Ok(v) => v,
                                            Err(e) => {
                                                warn!(error=?e, concat!("Error when ", $ctx));
                                                return $on_retry();
                                            }
                                        }
                                    };
                                }
    };
}

pub(super) use make_tx_try;
