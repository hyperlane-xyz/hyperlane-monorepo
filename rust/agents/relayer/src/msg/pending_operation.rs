use std::cmp::Ordering;
use std::time::Instant;

use async_trait::async_trait;
use eyre::Report;

/// A pending operation that will be run by the submitter and cause a
/// transaction to be sent.
#[async_trait]
pub trait PendingOperation {
    /// Prepare to run this operation. This will be called before every run and
    /// will usually have a very short gap between it and the run call.
    async fn prepare(&mut self) -> TxPrepareResult {
        if self.ready_to_be_processed() {
            TxPrepareResult::Ready
        } else {
            TxPrepareResult::NotReady
        }
    }

    /// Submit this operation to the blockchain and report if it was successful
    /// or not.
    async fn submit(&mut self) -> TxRunResult;

    async fn validate(&mut self) -> TxValidationResult {
        // default implementation is basically a no-op
        if self.ready_to_be_validated() {
            TxValidationResult::Valid
        } else if !self.submitted() {
            TxValidationResult::Invalid
        } else {
            TxValidationResult::Retry
        }
    }

    fn next_attempt_after(&self) -> Option<Instant>;

    fn submitted(&self) -> bool;

    fn ready_to_be_processed(&self) -> bool {
        !self.submitted()
            && self
                .next_attempt_after()
                .map_or(true, |a| Instant::now() >= a)
    }

    fn ready_to_be_validated(&self) -> bool {
        self.submitted()
            && self
                .next_attempt_after()
                .map_or(true, |a| Instant::now() >= a)
    }
}

impl PartialEq for dyn PendingOperation {
    fn eq(&self, other: &Self) -> bool {
        todo!()
    }
}

impl PartialOrd for dyn PendingOperation {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        todo!()
    }
}

pub enum TxPrepareResult {
    /// Txn is ready to be submitted
    Ready,
    /// This Txn is not ready to be attempted again yet
    NotReady,
    /// Txn preparation failed and we should not try again or it has already
    /// been processed.
    DoNotRetry,
    /// A retry-able error occurred and we should retry after
    /// `next_attempt_after`
    Retry,
    /// Pass the error up the chain, this is non-recoverable and indicates a
    /// system failure.
    CriticalFailure(Report),
}

/// The result of running a pending transaction.
pub enum TxRunResult {
    /// Transaction was successfully processed
    Success,
    /// Txn failed/reverted and we should not try again
    DoNotRetry,
    /// Txn failed/reverted and we should try again after `next_attempt_after`
    Retry,
    /// Pass the error up the chain, this is non-recoverable and indicates a
    /// system failure.
    CriticalFailure(Report),
}

pub enum TxValidationResult {
    /// Transaction was successfully validated as being included in the
    /// blockchain
    Valid,
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
                                            Err(e).context(concat!("When ", $ctx)).unwrap_err()
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
