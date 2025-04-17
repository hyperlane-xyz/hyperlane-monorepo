// TODO: uncomment if needed
// fn from_payload_status_into_result_for_confirmation(
//     status: &PayloadStatus,
// ) -> PendingOperationResult {
//     use submitter::PayloadDropReason::{
//         FailedSimulation, FailedToBuildAsTransaction, Reverted, UnhandledError,
//     };
//     use submitter::PayloadRetryReason::Reorged;
//     use submitter::PayloadStatus::{
//         Dropped as PayloadDropped, InTransaction, ReadyToSubmit, Retry,
//     };
//     use submitter::TransactionStatus::{
//         Dropped as TransactionDropped, Finalized, Included, Mempool, PendingInclusion,
//     };

//     use PendingOperationResult::*;

//     match status {
//         ReadyToSubmit => Confirm(SubmittedBySelf),
//         InTransaction(t) => match t {
//             Included | Mempool | PendingInclusion => Confirm(SubmittedBySelf),
//             TransactionDropped(_) => Reprepare(ReprepareReason::RevertedOrReorged),
//             Finalized => Success,
//         },
//         PayloadDropped(d) => match d {
//             FailedToBuildAsTransaction | FailedSimulation | UnhandledError => {
//                 Reprepare(ReprepareReason::ErrorEstimatingGas)
//             }
//             Reverted => Reprepare(ReprepareReason::RevertedOrReorged),
//         },
//         Retry(r) => match r {
//             Reorged => Confirm(SubmittedBySelf),
//         },
//     }
// }

// fn from_submitter_error_into_result_for_confirmation(
//     error: &SubmitterError,
// ) -> PendingOperationResult {
//     use submitter::SubmitterError::*;

//     use PendingOperationResult::*;

//     match error {
//         TxAlreadyExists | TxSubmissionError(_) => Confirm(SubmittedBySelf),
//         TxReverted => Reprepare(ReprepareReason::RevertedOrReorged),
//         NetworkError(_)
//         | ChannelSendFailure(_)
//         | ChannelClosed
//         | EyreError(_)
//         | PayloadNotFound
//         | DbError(_)
//         | ChainCommunicationError(_) => Reprepare(ReprepareReason::ErrorSubmitting),
//     }
// }
