use std::{
    cmp::Ordering,
    env,
    fmt::{Debug, Display},
    io::Write,
    sync::Arc,
    time::{Duration, Instant},
};

use async_trait::async_trait;
use num::CheckedDiv;
use prometheus::IntGauge;
use serde::{Deserialize, Serialize};
use sha3::{digest::Update, Digest, Keccak256};
use strum::Display;
use tracing::warn;

use hyperlane_application::ApplicationReport;

use crate::{
    ChainResult, Decode, Encode, FixedPointNumber, HyperlaneDomain, HyperlaneMessage,
    HyperlaneProtocolError, Mailbox, TryBatchAs, TxOutcome, H256, U256,
};

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
#[typetag::serialize(tag = "type")]
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

    /// Get the operation status from the local db, if there is one
    fn retrieve_status_from_db(&self) -> Option<PendingOperationStatus>;

    /// The domain this operation will take place on.
    fn destination_domain(&self) -> &HyperlaneDomain;

    /// The sender address of this operation.
    fn sender_address(&self) -> &H256;

    /// The recipient address of this operation.
    fn recipient_address(&self) -> &H256;

    /// Label to use for metrics granularity.
    fn app_context(&self) -> Option<String>;

    /// Get the metric associated with this operation.
    fn get_metric(&self) -> Option<Arc<IntGauge>>;

    /// Decrement the metric associated with this operation if it exists.
    fn decrement_metric_if_exists(&self) {
        if let Some(metric) = self.get_metric() {
            metric.dec();
        }
    }

    /// Set the metric associated with this operation.
    fn set_metric(&mut self, metric: Arc<IntGauge>);

    /// The status of the operation, which should explain why it is in the
    /// queue.
    fn status(&self) -> PendingOperationStatus;

    /// Set the status of the operation.
    fn set_status(&mut self, status: PendingOperationStatus);

    /// Set the status of the operation and update the metrics.
    fn set_status_and_update_metrics(
        &mut self,
        status: Option<PendingOperationStatus>,
        new_metric: Arc<IntGauge>,
    ) {
        if let Some(status) = status {
            self.set_status(status);
        }
        if let Some(old_metric) = self.get_metric() {
            old_metric.dec();
        }
        new_metric.inc();
        self.set_metric(new_metric);
    }

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
    async fn submit(&mut self) -> PendingOperationResult;

    /// Set the outcome of the `submit` call
    fn set_submission_outcome(&mut self, outcome: TxOutcome);

    /// Get the estimated the cost of the `submit` call
    fn get_tx_cost_estimate(&self) -> Option<U256>;

    /// This will be called after the operation has been submitted and is
    /// responsible for checking if the operation has reached a point at
    /// which we consider it safe from reorgs.
    async fn confirm(&mut self) -> PendingOperationResult;

    /// Record the outcome of the operation
    async fn set_operation_outcome(
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
    fn set_retries(&mut self, retries: u32);

    /// Get the number of times this operation has been retried.
    fn get_retries(&self) -> u32;

    /// If this operation points to a mailbox contract, return it
    fn try_get_mailbox(&self) -> Option<Arc<dyn Mailbox>> {
        None
    }

    /// Creates payload for the operation
    async fn payload(&self) -> ChainResult<Vec<u8>>;

    /// Creates success criteria for the operation
    fn success_criteria(&self) -> ChainResult<Option<Vec<u8>>>;

    /// Public version of on_reprepare method
    fn on_reprepare(
        &mut self,
        err_msg: Option<String>,
        reason: ReprepareReason,
    ) -> PendingOperationResult;
}

#[derive(Debug, Display, Clone, Serialize, Deserialize, PartialEq)]
/// Status of a pending operation
/// WARNING: This enum is serialized to JSON and stored in the database, so to keep backwards compatibility, we shouldn't remove or rename any variants.
/// Adding new variants is fine.
pub enum PendingOperationStatus {
    /// The operation is ready to be prepared for the first time, or has just been loaded from storage
    FirstPrepareAttempt,
    /// The operation is ready to be prepared again, with the given reason
    #[strum(to_string = "Retry({0})")]
    Retry(ReprepareReason),
    /// The operation is ready to be submitted
    ReadyToSubmit,
    /// The operation has been submitted and is awaiting confirmation
    #[strum(to_string = "Confirm({0})")]
    Confirm(ConfirmReason),
}

impl Encode for PendingOperationStatus {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: Write,
    {
        // Serialize to JSON and write to the writer, to avoid having to implement the encoding manually
        let serialized = serde_json::to_vec(self)
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::Other, "Failed to serialize"))?;
        writer.write(&serialized)
    }
}

impl Decode for PendingOperationStatus {
    fn read_from<R>(reader: &mut R) -> Result<Self, HyperlaneProtocolError>
    where
        R: std::io::Read,
        Self: Sized,
    {
        // Deserialize from JSON and read from the reader, to avoid having to implement the encoding / decoding manually
        serde_json::from_reader(reader).map_err(|err| {
            HyperlaneProtocolError::IoError(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("Failed to deserialize. Error: {}", err),
            ))
        })
    }
}

#[derive(Display, Debug, Clone, Serialize, Deserialize, PartialEq)]
/// Reasons for repreparing an operation
/// WARNING: This enum is serialized to JSON and stored in the database, so to keep backwards compatibility, we shouldn't remove or rename any variants.
/// Adding new variants is fine.
pub enum ReprepareReason {
    #[strum(to_string = "Error checking message delivery status")]
    /// Error checking message delivery status
    ErrorCheckingDeliveryStatus,
    #[strum(to_string = "Error checking if message recipient is a contract")]
    /// Error checking if message recipient is a contract
    ErrorCheckingIfRecipientIsContract,
    #[strum(to_string = "Error fetching ISM address")]
    /// Error fetching ISM address
    ErrorFetchingIsmAddress,
    #[strum(to_string = "Error getting message metadata builder")]
    /// Error getting message metadata builder
    ErrorGettingMetadataBuilder,
    #[strum(to_string = "Error submitting")]
    /// Error submitting
    ErrorSubmitting,
    #[strum(to_string = "Error building metadata")]
    /// Error building metadata
    ErrorBuildingMetadata,
    #[strum(to_string = "Could not fetch metadata")]
    /// Could not fetch metadata
    CouldNotFetchMetadata,
    #[strum(to_string = "Error estimating costs for process call")]
    /// Error estimating costs for process call
    ErrorEstimatingGas,
    #[strum(to_string = "Error checking if message meets gas payment requirement")]
    /// Error checking if message meets gas payment requirement
    ErrorCheckingGasRequirement,
    #[strum(to_string = "Gas payment requirement not met")]
    /// Gas payment requirement not met
    GasPaymentRequirementNotMet,
    /// Gas payment not found
    GasPaymentNotFound,
    #[strum(to_string = "Message delivery estimated gas exceeds max gas limit")]
    /// Message delivery estimated gas exceeds max gas limit
    ExceedsMaxGasLimit,
    #[strum(to_string = "Delivery transaction reverted or reorged")]
    /// Delivery transaction reverted or reorged
    RevertedOrReorged,
    #[strum(to_string = "Message metadata refused")]
    /// The metadata building was refused for the message
    MessageMetadataRefused,
    #[strum(to_string = "ApplicationReport({0})")]
    /// Application report
    ApplicationReport(ApplicationReport),
    #[strum(to_string = "Failed to create payload for message and metadata")]
    /// Failed to create payload for message and metadata
    ErrorCreatingPayload,
    #[strum(to_string = "Failed to store payload uuid by message id")]
    /// Failed to store payload uuid by message id
    ErrorStoringPayloadUuidsByMessageId,
    #[strum(to_string = "Failed to retrieve payload uuids by message id")]
    /// Failed to retrieve payload uuids by message id
    ErrorRetrievingPayloadUuids,
    #[strum(to_string = "Failed to retrieve payload uuid status by message id")]
    /// Failed to retrieve payload status by message id
    ErrorRetrievingPayloadStatus,
    #[strum(to_string = "Failed to create payload success criteria")]
    /// Failed to create payload success criteria
    ErrorCreatingPayloadSuccessCriteria,
}

#[derive(Display, Debug, Clone, Serialize, Deserialize, PartialEq)]
/// Reasons for confirming an operation
/// WARNING: This enum is serialized to JSON and stored in the database, so to keep backwards compatibility, we shouldn't remove or rename any variants.
/// Adding new variants is fine.
pub enum ConfirmReason {
    #[strum(to_string = "Submitted by this relayer")]
    /// Operation was submitted by this relayer
    SubmittedBySelf,
    #[strum(to_string = "Already submitted, awaiting confirmation")]
    /// Operation was already submitted (either by another relayer, or by a previous run of this relayer), awaiting confirmation
    AlreadySubmitted,
    /// Error checking message delivery status
    ErrorConfirmingDelivery,
    /// Error storing delivery outcome
    ErrorRecordingProcessSuccess,
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

        fn salted_hash(id: &H256, salt: &[u8]) -> H256 {
            H256::from_slice(Keccak256::new().chain(id).chain(salt).finalize().as_slice())
        }

        match (self.next_attempt_after(), other.next_attempt_after()) {
            (Some(a), Some(b)) => a.cmp(&b),
            // No time means it should come before
            (None, Some(_)) => Less,
            (Some(_), None) => Greater,
            (None, None) => {
                let mixing =
                    env::var("HYPERLANE_RELAYER_MIXING_ENABLED").map_or(false, |v| v == "true");
                if !mixing {
                    if self.origin_domain_id() == other.origin_domain_id() {
                        // Should execute in order of nonce for the same origin
                        self.priority().cmp(&other.priority())
                    } else {
                        // There is no priority between these messages, so arbitrarily use the id
                        self.id().cmp(&other.id())
                    }
                } else {
                    let salt = env::var("HYPERLANE_RELAYER_MIXING_SALT")
                        .map_or(0, |v| v.parse::<u32>().unwrap_or(0))
                        .to_vec();
                    let self_hash = salted_hash(&self.id(), &salt);
                    let other_hash = salted_hash(&other.id(), &salt);
                    self_hash.cmp(&other_hash)
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
    Reprepare(ReprepareReason),
    /// Do not attempt to run the operation again, forget about it
    Drop,
    /// Send this message straight to the confirm queue
    Confirm(ConfirmReason),
}

#[cfg(test)]
mod tests;
