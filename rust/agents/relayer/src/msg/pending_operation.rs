use std::cmp::Ordering;
use std::time::Instant;

use async_trait::async_trait;
use eyre::Report;

/// A pending operation that will be run by the submitter and cause a
/// transaction to be sent.
#[async_trait]
trait PendingOperation {
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

    fn next_attempt_after(&self) -> Option<Instant>;

    fn ready_to_be_processed(&self) -> bool {
        self.next_attempt_after()
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

enum TxPrepareResult {
    /// Txn is ready to be submitted
    Ready,
    /// This Txn is not ready to be attempted again yet
    NotReady,
    /// Txn preparation failed and we should not try again
    Failure,
    /// A retry-able error occurred and we should retry after
    /// `next_attempt_after`
    Retry,
    /// Pass the error up the chain, this is non-recoverable and indicates a
    /// system failure.
    CriticalFailure(Report),
}

/// The result of running a pending transaction.
enum TxRunResult {
    /// Transaction was successfully processed
    Success,
    /// Txn failed/reverted and we should not try again
    Failure,
    /// Txn failed/reverted and we should try again after `next_attempt_after`
    Retry,
    /// Pass the error up the chain, this is non-recoverable and indicates a
    /// system failure.
    CriticalFailure(Report),
}
