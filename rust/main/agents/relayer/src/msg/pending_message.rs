#![allow(clippy::clone_on_ref_ptr)] // TODO: `rustc` 1.80.1 clippy issue

use std::{
    fmt::{Debug, Formatter},
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use derive_new::new;
use eyre::Result;
use prometheus::IntGauge;
use serde::{de::DeserializeOwned, Serialize};
use tokio::sync::RwLock;
use tracing::{debug, error, info, info_span, instrument, trace, warn, Instrument, Level};

use hyperlane_base::{
    cache::{FunctionCallCache, LocalCache, MeteredCache, OptionalCache},
    db::{HyperlaneDb, PendingMessageRetryState},
};
use hyperlane_core::{
    gas_used_by_operation, BatchItem, ChainCommunicationError, ChainResult, ConfirmReason,
    FixedPointNumber, HyperlaneChain, HyperlaneDomain, HyperlaneMessage, Mailbox,
    MessageSubmissionData, Metadata, PendingOperation, PendingOperationResult,
    PendingOperationStatus, ReprepareReason, TryBatchAs, TxCostEstimate, TxOutcome, H256, U256,
};
use hyperlane_operation_verifier::ApplicationOperationVerifier;

use crate::{
    metrics::message_submission::{
        MessageSubmissionMetrics, MetadataBuildMetric, MetadataWaitObservation,
    },
    msg::metadata::{MessageMetadataBuildParams, MetadataBuildError},
};

use super::{
    gas_payment::{GasPaymentEnforcer, GasPolicyStatus},
    metadata::{BuildsBaseMetadata, MessageMetadataBuilder, MetadataBuilder},
};

/// a default of 66 is picked, so messages are retried for 2 weeks (period confirmed by @nambrot) before being skipped.
/// See this PR for why 66 retries means 2 weeks:
/// https://github.com/hyperlane-xyz/hyperlane-monorepo/pull/5468
pub const DEFAULT_MAX_MESSAGE_RETRIES: u32 = 66;
pub const CONFIRM_DELAY: Duration = if cfg!(any(test, feature = "test-utils")) {
    // Wait 5 seconds after submitting the message before confirming in test mode
    Duration::from_secs(5)
} else {
    // Wait 10 min after submitting the message before confirming in normal/production mode
    Duration::from_secs(60 * 10)
};

pub const RETRIEVED_MESSAGE_LOG: &str = "Message status retrieved from db";
pub const USE_CACHE_METADATA_LOG: &str = "Reusing cached metadata";
pub const INVALIDATE_CACHE_METADATA_LOG: &str = "Invalidating cached metadata";
pub const ISM_MAX_DEPTH: u32 = 13;
pub const ISM_MAX_COUNT: u32 = 100;

const VALIDATOR_SIGNATURE_FAST_RETRY_INTERVAL: Duration = Duration::from_secs(2);
const VALIDATOR_SIGNATURE_FAST_RETRY_MAX: u32 = 3;

/// Revert string emitted by the ICA router when the originating commit has not
/// yet been confirmed on-chain. There is no typed error variant for this today —
/// it is an opaque on-chain revert string — so Display-format substring matching
/// is the only available signal. Use Display (not Debug) to avoid a dependency
/// on the internal structure of the error type's Debug representation.
const ICA_INVALID_REVEAL: &str = "ICA: Invalid Reveal";
const REVEAL_POLL_FAST_INTERVAL: Duration = Duration::from_secs(1);
const REVEAL_POLL_FAST_MAX: u32 = 30; // first 30s: poll every 1s
const REVEAL_POLL_SLOW_INTERVAL: Duration = Duration::from_secs(5);
const REVEAL_POLL_SLOW_COUNT: u32 = 36; // next 3min: poll every 5s
const REVEAL_POLL_TOTAL_MAX: u32 = REVEAL_POLL_FAST_MAX + REVEAL_POLL_SLOW_COUNT;

fn is_ica_invalid_reveal(err: &impl std::fmt::Display) -> bool {
    err.to_string().contains(ICA_INVALID_REVEAL)
}

/// The outcome of a gas payment requirement check.
enum GasPaymentRequirementOutcome {
    MeetsRequirement(U256),
    RequirementNotMet(PendingOperationResult),
}

/// The message context contains the links needed to submit a message. Each
/// instance is for a unique origin -> destination pairing.
pub struct MessageContext {
    /// Mailbox on the destination chain.
    pub destination_mailbox: Arc<dyn Mailbox>,
    /// Origin chain database to verify gas payments.
    pub origin_db: Arc<dyn HyperlaneDb>,
    /// Cache to store commonly used data calls.
    pub cache: OptionalCache<MeteredCache<LocalCache>>,
    /// Used to construct the ISM metadata needed to verify a message from the
    /// origin.
    pub metadata_builder: Arc<dyn BuildsBaseMetadata>,
    /// Used to determine if messages from the origin have made sufficient gas
    /// payments.
    pub origin_gas_payment_enforcer: Arc<RwLock<GasPaymentEnforcer>>,
    /// Hard limit on transaction gas when submitting a transaction to the
    /// destination.
    pub transaction_gas_limit: Option<U256>,
    pub metrics: MessageSubmissionMetrics,
    /// Application operation verifier
    pub application_operation_verifier: Arc<dyn ApplicationOperationVerifier>,
}

/// A message that is pending processing and submission.
#[derive(new, Serialize)]
pub struct PendingMessage {
    pub message: HyperlaneMessage,
    #[serde(skip_serializing)]
    ctx: Arc<MessageContext>,
    status: PendingOperationStatus,
    app_context: Option<String>,
    #[serde(skip_serializing)]
    max_retries: u32,
    #[new(default)]
    submitted: bool,
    #[new(default)]
    #[serde(skip_serializing)]
    pub(crate) submission_data: Option<Box<MessageSubmissionData>>,
    #[new(default)]
    num_retries: u32,
    #[new(value = "Instant::now()")]
    #[serde(skip_serializing)]
    last_attempted_at: Instant,
    #[new(default)]
    #[serde(skip_serializing)]
    next_attempt_after: Option<Instant>,
    #[new(default)]
    #[serde(skip_serializing)]
    submission_outcome: Option<TxOutcome>,
    #[new(default)]
    #[serde(skip_serializing)]
    metadata: Option<Metadata>,
    #[new(default)]
    #[serde(skip_serializing)]
    metric: Option<Arc<IntGauge>>,
    /// When true, drop the message immediately once `num_retries > max_retries`
    /// instead of parking it in the final long backoff arm. Set by the relay API
    /// so that small `max_retries` budgets are respected without touching the
    /// behavior of normal relayer messages.
    ///
    /// Intentionally non-persistent (`skip_serializing`, no `deserialize`): the relay
    /// API injects messages directly into the processor channel without a DB write, so
    /// rehydration via the DB-loader path never sees these messages while fail_fast is
    /// relevant. If a message were recovered through the DB path before the indexer
    /// catches up, it would rehydrate with `fail_fast=false` and follow the normal
    /// long-backoff arm — acceptable degradation, not a correctness issue.
    #[new(default)]
    #[serde(skip_serializing)]
    fail_fast: bool,
    /// Number of consecutive times this message has been returned to the queue
    /// due to an "ICA: Invalid Reveal" simulation failure. Tracked separately
    /// from `num_retries` so these transient waits don't consume the fail-fast
    /// retry budget.
    #[new(default)]
    #[serde(skip_serializing)]
    ica_reveal_attempts: u32,
}

impl Drop for PendingMessage {
    fn drop(&mut self) {
        self.ctx.metrics.finish_metadata_wait(
            self.message.id(),
            self.app_context.as_deref(),
            false,
        );
    }
}

impl Debug for PendingMessage {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        // intentionally leaves out ctx
        let now = Instant::now();
        let last_attempt = now.duration_since(self.last_attempted_at).as_secs();
        let next_attempt = self
            .next_attempt_after
            .map(|a| {
                if a >= now {
                    a.duration_since(now).as_secs()
                } else {
                    0
                }
            })
            .unwrap_or(0);
        write!(f, "PendingMessage {{ num_retries: {}, since_last_attempt_s: {last_attempt}, next_attempt_after_s: {next_attempt}, message_id: {:?}, status: {:?}, app_context: {:?} }}",
               self.num_retries, self.message.id(), self.status, self.app_context)
    }
}

impl PartialEq for PendingMessage {
    fn eq(&self, other: &Self) -> bool {
        self.num_retries == other.num_retries
            && self.message.nonce == other.message.nonce
            && self.message.origin == other.message.origin
    }
}

impl Eq for PendingMessage {}

impl TryBatchAs<HyperlaneMessage> for PendingMessage {
    fn try_batch(&self) -> ChainResult<BatchItem<HyperlaneMessage>> {
        match self.submission_data.as_ref() {
            None => {
                warn!("Cannot batch message without submission data, returning BatchingFailed");
                Err(ChainCommunicationError::BatchingFailed)
            }
            Some(data) => Ok(BatchItem::new(
                self.message.clone(),
                data.as_ref().clone(),
                self.ctx.destination_mailbox.clone(),
            )),
        }
    }
}

#[async_trait]
#[typetag::serialize]
impl PendingOperation for PendingMessage {
    fn id(&self) -> H256 {
        self.message.id()
    }

    fn status(&self) -> PendingOperationStatus {
        self.status.clone()
    }

    fn set_status(&mut self, status: PendingOperationStatus) {
        // Manual status commits atomically with the cleared retry deadline.
        if status != PendingOperationStatus::Retry(ReprepareReason::Manual) {
            if let Err(e) = self
                .ctx
                .origin_db
                .store_status_by_message_id(&self.message.id(), &status)
            {
                warn!(message_id = ?self.message.id(), err = %e, status = %status, "Persisting `status` failed for message");
            }
        }
        self.status = status;
    }

    fn priority(&self) -> u32 {
        self.message.nonce
    }

    fn origin_domain_id(&self) -> u32 {
        self.message.origin
    }

    fn destination_domain(&self) -> &HyperlaneDomain {
        self.ctx.destination_mailbox.domain()
    }

    fn sender_address(&self) -> &H256 {
        &self.message.sender
    }

    fn recipient_address(&self) -> &H256 {
        &self.message.recipient
    }

    fn body(&self) -> &[u8] {
        &self.message.body
    }

    fn retrieve_status_from_db(&self) -> Option<PendingOperationStatus> {
        match self.ctx.origin_db.retrieve_status_by_message_id(&self.id()) {
            Ok(status) => status,
            Err(e) => {
                warn!(error=?e, "Failed to retrieve status for message");
                None
            }
        }
    }

    fn app_context(&self) -> Option<String> {
        self.app_context.clone()
    }

    #[instrument(skip(self), fields(id=?self.id()), level = "debug")]
    async fn prepare(&mut self) -> PendingOperationResult {
        if !self.is_ready() {
            trace!("Message is not ready to be submitted yet");
            return PendingOperationResult::NotReady;
        }

        // If the message has already been processed, e.g. due to another relayer having
        // already processed, then mark it as already-processed, and move on to
        // the next tick.
        let is_already_delivered = match self
            .ctx
            .destination_mailbox
            .delivered(self.message.id())
            .await
        {
            Ok(is_delivered) => is_delivered,
            Err(err) => {
                return self.on_reprepare(Some(err), ReprepareReason::ErrorCheckingDeliveryStatus);
            }
        };
        if is_already_delivered {
            debug!("Message has already been delivered, marking as submitted.");
            self.ctx.destination_mailbox.on_delivered(&self.message);
            self.submitted = true;
            self.set_next_attempt_after(CONFIRM_DELAY);
            return PendingOperationResult::Confirm(ConfirmReason::AlreadySubmitted);
        }

        // We cannot deliver to an address that is not a contract so check and drop if it isn't.
        let is_contract = match self.is_recipient_contract().await {
            Ok(is_contract) => is_contract,
            Err(reprepare_reason) => return reprepare_reason,
        };
        if !is_contract {
            info!(
                recipient=?self.message.recipient,
                "Dropping message because recipient is not a contract"
            );
            return PendingOperationResult::Drop;
        }

        // Perform a preflight check to see if we can short circuit the gas
        // payment requirement check early without performing expensive
        // operations like metadata building or gas estimation.
        if let GasPaymentRequirementOutcome::RequirementNotMet(op_result) =
            self.meets_gas_payment_requirement_preflight_check().await
        {
            info!("Message does not meet the gas payment requirement preflight check");
            return op_result;
        }

        // If metadata is already built, check gas estimation works.
        // If gas estimation fails, invalidate cache and rebuild it again.
        // Exception: ICA reveal failures are transient (commit not yet confirmed) and
        // unrelated to metadata validity — don't clear the cache so CCIP data isn't
        // re-fetched on every 1s poll cycle.
        let tx_cost_estimate = match self.metadata.as_ref() {
            Some(metadata) => {
                match self
                    .ctx
                    .destination_mailbox
                    .process_estimate_costs(&self.message, metadata)
                    .await
                {
                    Ok(s) => {
                        self.ica_reveal_attempts = 0;
                        tracing::debug!(USE_CACHE_METADATA_LOG);
                        Some(s)
                    }
                    Err(e)
                        if is_ica_invalid_reveal(&e)
                            && self.ica_reveal_attempts < REVEAL_POLL_TOTAL_MAX =>
                    {
                        return self.requeue_ica_reveal();
                    }
                    Err(_) => {
                        self.clear_metadata();
                        None
                    }
                }
            }
            None => None,
        };

        let metadata = match self.metadata.as_ref() {
            Some(metadata) => {
                tracing::debug!(USE_CACHE_METADATA_LOG);
                metadata.clone()
            }
            _ => match self.build_metadata().await {
                Ok(metadata) => {
                    self.metadata = Some(metadata.clone());
                    metadata
                }
                Err(err) => {
                    return err;
                }
            },
        };

        // Estimate transaction costs for the process call. If there are issues, it's
        // likely that gas estimation has failed because the message is
        // reverting. This is defined behavior, so we just log the error and
        // move onto the next tick.
        let tx_cost_estimate = match tx_cost_estimate {
            // reuse old gas cost estimate if it succeeded
            Some(cost) => cost,
            None => {
                debug!(
                    message_id = ?self.message.id(),
                    "Dry-run simulating process call before submission"
                );
                match self
                    .ctx
                    .destination_mailbox
                    .process_estimate_costs(&self.message, &metadata)
                    .await
                {
                    Ok(cost) => {
                        self.ica_reveal_attempts = 0;
                        info!(
                            message_id = ?self.message.id(),
                            gas_limit = ?cost.gas_limit,
                            "Dry-run simulation succeeded"
                        );
                        cost
                    }
                    Err(e) => {
                        if is_ica_invalid_reveal(&e)
                            && self.ica_reveal_attempts < REVEAL_POLL_TOTAL_MAX
                        {
                            return self.requeue_ica_reveal();
                        }
                        // Only reset on non-reveal errors; leave attempts pinned at cap so a
                        // permanently-failing reveal doesn't re-enter the fast-poll burst.
                        if !is_ica_invalid_reveal(&e) {
                            self.ica_reveal_attempts = 0;
                        }
                        warn!(
                            message_id = ?self.message.id(),
                            error = %e,
                            "Dry-run simulation failed"
                        );
                        let reason = self
                            .clarify_reason(ReprepareReason::ErrorEstimatingGas)
                            .await
                            .unwrap_or(ReprepareReason::ErrorEstimatingGas);
                        self.clear_metadata();
                        return self.on_reprepare(Some(e), reason);
                    }
                }
            }
        };

        // Get the gas_limit if the gas payment requirement has been met,
        // otherwise return a PendingOperationResult and move on.
        let gas_limit = match self.meets_gas_payment_requirement(&tx_cost_estimate).await {
            GasPaymentRequirementOutcome::MeetsRequirement(gas_limit) => gas_limit,
            GasPaymentRequirementOutcome::RequirementNotMet(op_result) => {
                info!("Message does not meet the gas payment requirement after gas estimation");
                return op_result;
            }
        };

        // Go ahead and attempt processing of message to destination chain.
        debug!(
            ?gas_limit,
            ?tx_cost_estimate,
            "Gas payment requirement met, ready to process message"
        );

        if let Some(max_limit) = self.ctx.transaction_gas_limit {
            if gas_limit > max_limit {
                // TODO: consider dropping instead of repreparing in this case
                self.clear_metadata();
                return self.on_reprepare::<String>(None, ReprepareReason::ExceedsMaxGasLimit);
            }
        }

        self.submission_data = Some(Box::new(MessageSubmissionData {
            metadata,
            gas_limit,
        }));
        PendingOperationResult::Success
    }

    #[instrument(skip(self), fields(id=?self.id(), domain=%self.destination_domain()))]
    async fn submit(&mut self) -> PendingOperationResult {
        if self.submitted {
            // this message has already been submitted, possibly not by us
            return PendingOperationResult::Success;
        }

        let state = self
            .submission_data
            .clone()
            .expect("Pending message must be prepared before it can be submitted");

        // To avoid spending gas on a tx that will revert, dry-run just before submitting.
        // Note: fail_fast (relay-API) messages never reach this method — they go through
        // submit_via_lander → payload(), not submit(). This dry-run only guards the classic path.
        if let Some(metadata) = self.metadata.as_ref() {
            debug!(
                message_id = ?self.message.id(),
                "Dry-run simulating process call before submission"
            );
            if let Err(e) = self
                .ctx
                .destination_mailbox
                .process_estimate_costs(&self.message, metadata)
                .await
            {
                warn!(
                    message_id = ?self.message.id(),
                    error = %e,
                    "Dry-run simulation failed"
                );
                let reason = self
                    .clarify_reason(ReprepareReason::ErrorEstimatingGas)
                    .await
                    .unwrap_or(ReprepareReason::ErrorEstimatingGas);
                self.clear_metadata();
                return self.on_reprepare::<String>(None, reason);
            }
        }

        // We use the estimated gas limit from the prior call to
        // `process_estimate_costs` to avoid a second gas estimation.
        let tx_outcome = self
            .ctx
            .destination_mailbox
            .process(&self.message, &state.metadata, Some(state.gas_limit))
            .await;
        match tx_outcome {
            Ok(outcome) => {
                self.set_operation_outcome(outcome, state.gas_limit).await;
                self.ctx
                    .destination_mailbox
                    .on_submitted_success(&self.message);
                PendingOperationResult::Confirm(ConfirmReason::SubmittedBySelf)
            }
            Err(e) => {
                error!(error=?e, "Error when processing message");
                self.clear_metadata();
                return PendingOperationResult::Reprepare(ReprepareReason::ErrorSubmitting);
            }
        }
    }

    fn set_submission_outcome(&mut self, outcome: TxOutcome) {
        self.submission_outcome = Some(outcome);
    }

    fn get_tx_cost_estimate(&self) -> Option<U256> {
        self.submission_data.as_ref().map(|d| d.gas_limit)
    }

    async fn confirm(&mut self) -> PendingOperationResult {
        if !self.is_ready() {
            return PendingOperationResult::NotReady;
        }

        let is_delivered = match self
            .ctx
            .destination_mailbox
            .delivered(self.message.id())
            .await
        {
            Ok(is_delivered) => is_delivered,
            Err(err) => {
                return self.on_reconfirm(Some(err), "Error confirming message delivery");
            }
        };

        if is_delivered {
            if let Err(err) = self.record_message_process_success() {
                return self
                    .on_reconfirm(Some(err), "Error when recording message process success");
            }
            self.ctx.destination_mailbox.on_delivered(&self.message);
            info!(
                submission=?self.submission_outcome,
                "Message successfully processed"
            );
            PendingOperationResult::Success
        } else {
            warn!(message_id = ?self.message.id(), tx_outcome=?self.submission_outcome, "Transaction attempting to process message either reverted or was reorged");
            let span = info_span!(
                "Error: Transaction attempting to process message either reverted or was reorged",
                tx_outcome=?self.submission_outcome,
                message_id=?self.message.id()
            );
            self.on_reprepare::<String>(None, ReprepareReason::RevertedOrReorged)
                .instrument(span)
                .into_inner()
        }
    }

    async fn set_operation_outcome(
        &mut self,
        submission_outcome: TxOutcome,
        submission_estimated_cost: U256,
    ) {
        let Some(operation_estimate) = self.get_tx_cost_estimate() else {
            warn!("Cannot set operation outcome without a cost estimate set previously");
            return;
        };
        // calculate the gas used by the operation
        let gas_used_by_operation = match gas_used_by_operation(
            &submission_outcome,
            submission_estimated_cost,
            operation_estimate,
        ) {
            Ok(gas_used_by_operation) => gas_used_by_operation,
            Err(e) => {
                warn!(error = %e, "Error when calculating gas used by operation, falling back to charging the full cost of the tx. Are gas estimates enabled for this chain?");
                submission_outcome.gas_used
            }
        };
        let operation_outcome = TxOutcome {
            gas_used: gas_used_by_operation,
            ..submission_outcome
        };
        // record it in the db, to subtract from the sender's igp allowance
        if let Err(e) = self
            .ctx
            .origin_gas_payment_enforcer
            .read()
            .await
            .record_tx_outcome(&self.message, operation_outcome.clone())
        {
            error!(error=?e, "Error when recording tx outcome");
        }
        // set the outcome in `Self` as well, for later logging
        self.set_submission_outcome(operation_outcome);
        debug!(
            actual_gas_for_message = ?gas_used_by_operation,
            message_gas_estimate = ?operation_estimate,
            submission_gas_estimate = ?submission_estimated_cost,
            hyp_message = ?self.message,
            "Gas used by message submission"
        );
    }

    fn next_attempt_after(&self) -> Option<Instant> {
        self.next_attempt_after
    }

    fn set_next_attempt_after(&mut self, delay: Duration) {
        self.next_attempt_after = Instant::now().checked_add(delay);
        self.persist_retry_state(Some(delay), None);
    }

    fn reset_attempts(&mut self) -> bool {
        self.reset_attempts()
    }

    fn set_retries(&mut self, retries: u32) {
        self.set_retries(retries);
    }

    fn get_retries(&self) -> u32 {
        self.num_retries
    }

    fn try_get_mailbox(&self) -> Option<Arc<dyn Mailbox>> {
        Some(self.ctx.destination_mailbox.clone())
    }

    fn on_submitted_success(&self) {
        self.ctx
            .destination_mailbox
            .on_submitted_success(&self.message);
    }

    fn get_metric(&self) -> Option<Arc<IntGauge>> {
        self.metric.clone()
    }

    fn set_metric(&mut self, metric: Arc<IntGauge>) {
        self.metric = Some(metric);
    }

    async fn payload(&self) -> ChainResult<Vec<u8>> {
        let mailbox = &self.ctx.destination_mailbox;
        let message = &self.message;
        let submission_data = self
            .submission_data
            .as_ref()
            .expect("Pending message must be prepared before we can create payload for it");
        let metadata = &submission_data.metadata;
        let payload = mailbox.process_calldata(message, metadata).await?;
        Ok(payload)
    }

    fn success_criteria(&self) -> ChainResult<Option<Vec<u8>>> {
        let mailbox = &self.ctx.destination_mailbox;
        let message = &self.message;
        mailbox.delivered_calldata(message.id())
    }

    fn on_reprepare(
        &mut self,
        err: Option<String>,
        reason: ReprepareReason,
    ) -> PendingOperationResult {
        self.on_reprepare(err, reason)
    }
}

impl PendingMessage {
    /// Constructor that tries reading the retry count from the HyperlaneDB in order to recompute the `next_attempt_after`.
    /// If the message has been retried more than `max_retries`, it will return `None`.
    /// In case of failure, behaves like `Self::new(...)`.
    pub fn maybe_from_persisted_retries(
        message: HyperlaneMessage,
        ctx: Arc<MessageContext>,
        app_context: Option<String>,
        max_retries: u32,
    ) -> Option<Self> {
        let retry_state = Self::get_retry_state(ctx.origin_db.clone(), &message);
        let legacy_num_retries = Self::get_num_retries(ctx.origin_db.clone(), &message);
        let (num_retries, mut retry_state) =
            Self::reconcile_retry_state(retry_state, legacy_num_retries, &message.id());
        if Self::should_skip(num_retries, max_retries) {
            return None;
        }
        let mut message_status = Self::get_message_status(ctx.origin_db.clone(), &message);
        // Old binaries persist Manual status without clearing the versioned deadline. On
        // roll-forward the operator's manual retry remains authoritative at equal counts.
        if message_status == PendingOperationStatus::Retry(ReprepareReason::Manual)
            && retry_state
                .as_ref()
                .is_some_and(|state| state.next_attempt_at_millis.is_some())
        {
            let normalized = PendingMessageRetryState::new(num_retries, None, None, None);
            if let Err(err) = ctx
                .origin_db
                .store_pending_message_retry_state_and_status_by_message_id(
                    &message.id(),
                    &normalized,
                    &message_status,
                )
            {
                warn!(message_id = ?message.id(), %err, "Failed to normalize legacy manual retry state");
            }
            retry_state = Some(normalized);
        }
        let reprepare_reason = match &message_status {
            PendingOperationStatus::Retry(r) => Some(r.clone()),
            _ => None,
        };
        let next_attempt_after = retry_state
            .as_ref()
            .and_then(|state| {
                Self::restore_retry_deadline(state, SystemTime::now(), Instant::now())
            })
            .or_else(|| {
                if retry_state.is_some() || num_retries == 0 {
                    None
                } else {
                    Self::next_attempt_after(num_retries, max_retries, reprepare_reason.as_ref())
                }
            });
        // While a deadline remains active, the retry record is the atomic source of its
        // reason too. This closes the crash window before the queue persists Retry(status).
        if next_attempt_after.is_some() {
            if let Some(reason) = retry_state.as_ref().and_then(|state| state.reason.clone()) {
                message_status = PendingOperationStatus::Retry(reason);
            }
        }
        let mut pending_message = Self::new(message, ctx, message_status, app_context, max_retries);
        pending_message.num_retries = num_retries;
        pending_message.next_attempt_after = next_attempt_after;
        Some(pending_message)
    }

    fn reconcile_retry_state(
        retry_state: Option<PendingMessageRetryState>,
        legacy_num_retries: u32,
        message_id: &H256,
    ) -> (u32, Option<PendingMessageRetryState>) {
        let Some(retry_state) = retry_state else {
            return (legacy_num_retries, None);
        };
        if legacy_num_retries > retry_state.retry_count {
            warn!(
                ?message_id,
                legacy_num_retries,
                retry_state_num_retries = retry_state.retry_count,
                "Ignoring stale durable retry state after legacy retry count advanced"
            );
            return (legacy_num_retries, None);
        }
        (retry_state.retry_count, Some(retry_state))
    }

    /// Set fail-fast mode: drop the message immediately when `num_retries` exceeds
    /// `max_retries` rather than parking it in the final long-backoff arm.
    /// Use this for relay API messages where a small retry budget must be enforced strictly.
    pub fn with_fail_fast(mut self) -> Self {
        self.fail_fast = true;
        self
    }

    fn next_attempt_after(
        num_retries: u32,
        max_retries: u32,
        reason: Option<&ReprepareReason>,
    ) -> Option<Instant> {
        PendingMessage::calculate_msg_backoff(num_retries, max_retries, None, reason)
            .and_then(|dur| Instant::now().checked_add(dur))
    }

    fn restore_retry_deadline(
        state: &PendingMessageRetryState,
        wall_now: SystemTime,
        monotonic_now: Instant,
    ) -> Option<Instant> {
        let deadline =
            UNIX_EPOCH.checked_add(Duration::from_millis(state.next_attempt_at_millis?))?;
        let remaining = deadline.duration_since(wall_now).ok()?;
        let original_delay = Duration::from_millis(state.retry_delay_millis?);
        monotonic_now.checked_add(remaining.min(original_delay))
    }

    fn get_retry_state(
        origin_db: Arc<dyn HyperlaneDb>,
        message: &HyperlaneMessage,
    ) -> Option<PendingMessageRetryState> {
        match origin_db.retrieve_pending_message_retry_state_by_message_id(&message.id()) {
            Ok(state) => state,
            Err(err) => {
                warn!(message_id = ?message.id(), %err, "Failed to read durable retry state; falling back to legacy retry count");
                None
            }
        }
    }

    #[cfg(test)]
    fn get_retries_or_skip(
        origin_db: Arc<dyn HyperlaneDb>,
        message: &HyperlaneMessage,
        max_retries: u32,
    ) -> Option<u32> {
        let num_retries = Self::get_num_retries(origin_db.clone(), message);
        if Self::should_skip(num_retries, max_retries) {
            return None;
        }
        Some(num_retries)
    }

    pub fn should_skip(retry_count: u32, max_retries: u32) -> bool {
        retry_count >= max_retries
    }

    fn get_num_retries(origin_db: Arc<dyn HyperlaneDb>, message: &HyperlaneMessage) -> u32 {
        match origin_db.retrieve_pending_message_retry_count_by_message_id(&message.id()) {
            Ok(Some(num_retries)) => num_retries,
            r => {
                trace!(message_id = ?message.id(), result = ?r, "Failed to read retry count from HyperlaneDB for message.");
                0
            }
        }
    }

    fn get_message_status(
        origin_db: Arc<dyn HyperlaneDb>,
        message: &HyperlaneMessage,
    ) -> PendingOperationStatus {
        // Attempt to fetch status about message from database
        if let Ok(Some(status)) = origin_db.retrieve_status_by_message_id(&message.id()) {
            // This event is used for E2E tests to ensure message statuses
            // are being properly loaded from the db
            if cfg!(feature = "test-utils") {
                tracing::event!(Level::DEBUG, ?status, id=?message.id(), RETRIEVED_MESSAGE_LOG);
            } else {
                tracing::event!(Level::TRACE, ?status, id=?message.id(), RETRIEVED_MESSAGE_LOG);
            }
            return status;
        }

        tracing::event!(
            if cfg!(feature = "test-utils") {
                Level::DEBUG
            } else {
                Level::TRACE
            },
            "Message status not found in db"
        );
        PendingOperationStatus::FirstPrepareAttempt
    }

    /// Checks if the recipient is a contract.
    /// This method will attempt to get the value from cache first. If it is a cache miss,
    /// it will request it from the provider. The result will be cached for future use.
    ///
    /// Implicit contract in this method: function name `is_contract` matches
    /// the name of the method `is_contract`.
    async fn is_recipient_contract(&mut self) -> Result<bool, PendingOperationResult> {
        let mailbox = self.ctx.destination_mailbox.clone();
        let domain_name = mailbox.domain().name();
        let fn_key = "is_contract";
        let fn_params = self.message.recipient;
        let provider = self.ctx.destination_mailbox.provider();

        // Check cache for recipient contract status
        if let Some(is_contract) = self
            .get_from_cache::<bool>(domain_name, fn_key, &fn_params)
            .await
        {
            return Ok(is_contract);
        }

        // Check if the recipient is a contract
        let is_contract = provider.is_contract(&fn_params).await.map_err(|err| {
            self.on_reprepare(
                Some(err),
                ReprepareReason::ErrorCheckingIfRecipientIsContract,
            )
        })?;

        // Cache the recipient contract status
        self.store_to_cache(domain_name, fn_key, &fn_params, &is_contract)
            .await;

        Ok(is_contract)
    }

    /// Fetches the recipient ISM address.
    /// This method will attempt to get the value from cache first. If it is a cache miss,
    /// it will request it from the Mailbox contract. The result will be cached for future use.
    ///
    /// Implicit contract in this method: function name `recipient_ism` matches
    /// the name of the method `recipient_ism`.
    async fn recipient_ism_address(&mut self) -> Result<H256, PendingOperationResult> {
        let domain = self.ctx.destination_mailbox.domain().name();
        let fn_key = "recipient_ism";
        let fn_params = self.message.recipient;

        // Check cache for recipient ISM address
        if let Some(ism_address) = self
            .get_from_cache::<H256>(domain, fn_key, &fn_params)
            .await
        {
            return Ok(ism_address);
        }

        // Fetch the recipient ISM address
        let ism_address = match self
            .ctx
            .destination_mailbox
            .recipient_ism(self.message.recipient)
            .await
        {
            Ok(ism_address) => ism_address,
            Err(err) => {
                return Err(self.on_reprepare(Some(err), ReprepareReason::ErrorFetchingIsmAddress));
            }
        };

        // Cache the recipient ISM address
        self.store_to_cache(domain, fn_key, &fn_params, &ism_address)
            .await;

        Ok(ism_address)
    }

    async fn get_from_cache<U: DeserializeOwned>(
        &self,
        domain_name: &str,
        fn_key: &str,
        fn_params: &(impl Serialize + Send + Sync),
    ) -> Option<U> {
        self.ctx
            .cache
            .get_cached_call_result::<U>(domain_name, fn_key, fn_params)
            .await
            .map_err(|err| {
                warn!(error=?err, ?fn_key, "Error checking cache stored result");
                err
            })
            .ok()
            .flatten()
    }

    async fn store_to_cache(
        &self,
        domain_name: &str,
        fn_key: &str,
        fn_params: &(impl Serialize + Send + Sync),
        result: &(impl Serialize + Send + Sync),
    ) {
        if let Err(err) = self
            .ctx
            .cache
            .cache_call_result(domain_name, fn_key, fn_params, result)
            .await
        {
            warn!(error=?err, ?fn_key, "Error caching result");
        }
    }
    /// A preflight check to see if a message could possibly meet
    /// a gas payment requirement prior to undertaking expensive operations
    /// like metadata building or gas estimation.
    /// If the message does not meet the gas payment requirement,
    /// Err(PendingOperationResult) is returned, with the PendingOperationResult intended
    /// to be propagated up by the prepare fn.
    async fn meets_gas_payment_requirement_preflight_check(
        &mut self,
    ) -> GasPaymentRequirementOutcome {
        // We test if the message may meet the gas payment requirement
        // with the most simple tx cost estimate: one that has zero cost
        // whatsoever. If the message does not meet the gas payment requirement
        // with zero cost, we can skip the metadata building and gas estimation
        // altogether. This covers the case of a message that did not pay our IGP,
        // which may violate the gas payment enforcement policies depending on
        // the configuration, but also allows us to be tolerant of the configuration
        // allowing no payment at all.
        let zero_cost = TxCostEstimate {
            gas_limit: U256::zero(),
            gas_price: FixedPointNumber::zero(),
            l2_gas_limit: None,
        };

        self.meets_gas_payment_requirement(&zero_cost).await
    }

    /// Returns the gas limit if the message meets the gas payment requirement,
    /// otherwise returns an Err(PendingOperationResult), with the PendingOperationResult intended
    /// to be propagated up by the prepare fn.
    async fn meets_gas_payment_requirement(
        &mut self,
        tx_cost_estimate: &TxCostEstimate,
    ) -> GasPaymentRequirementOutcome {
        let gas_limit = self
            .ctx
            .origin_gas_payment_enforcer
            .read()
            .await
            .message_meets_gas_payment_requirement(&self.message, tx_cost_estimate)
            .await;

        let gas_limit = match gas_limit {
            Ok(gas_limit) => gas_limit,
            Err(err) => {
                return GasPaymentRequirementOutcome::RequirementNotMet(
                    self.on_reprepare(Some(err), ReprepareReason::ErrorCheckingGasRequirement),
                );
            }
        };

        let gas_limit = match gas_limit {
            GasPolicyStatus::NoPaymentFound => {
                return GasPaymentRequirementOutcome::RequirementNotMet(
                    self.on_reprepare::<String>(None, ReprepareReason::GasPaymentNotFound),
                )
            }
            GasPolicyStatus::PolicyNotMet => {
                return GasPaymentRequirementOutcome::RequirementNotMet(
                    self.on_reprepare::<String>(None, ReprepareReason::GasPaymentRequirementNotMet),
                )
            }
            GasPolicyStatus::PolicyMet(gas_limit) => gas_limit,
        };

        GasPaymentRequirementOutcome::MeetsRequirement(gas_limit)
    }

    fn requeue_ica_reveal(&mut self) -> PendingOperationResult {
        self.ica_reveal_attempts = self.ica_reveal_attempts.saturating_add(1);
        let (interval, phase) = if self.ica_reveal_attempts <= REVEAL_POLL_FAST_MAX {
            (REVEAL_POLL_FAST_INTERVAL, "fast")
        } else {
            (REVEAL_POLL_SLOW_INTERVAL, "slow")
        };
        warn!(
            message_id = ?self.message.id(),
            attempt = self.ica_reveal_attempts,
            max_attempts = REVEAL_POLL_TOTAL_MAX,
            phase,
            interval_secs = interval.as_secs(),
            "Reveal simulation failed (ICA: Invalid Reveal) — commit not yet confirmed, re-queuing"
        );
        self.delay_reprepare(interval, ReprepareReason::AwaitingIcaReveal)
    }

    /// Return `Reprepare` after `delay` without consuming the fail-fast retry budget.
    /// Used for transient waits (e.g. ICA reveal polling) so that small `max_retries`
    /// budgets are not exhausted by infrastructure delays.
    fn delay_reprepare(
        &mut self,
        delay: Duration,
        reason: ReprepareReason,
    ) -> PendingOperationResult {
        self.submitted = false;
        self.last_attempted_at = Instant::now();
        self.next_attempt_after = self.last_attempted_at.checked_add(delay);
        self.persist_retry_state(Some(delay), Some(reason.clone()));
        PendingOperationResult::Reprepare(reason)
    }

    fn on_reprepare<E: Debug>(
        &mut self,
        err: Option<E>,
        reason: ReprepareReason,
    ) -> PendingOperationResult {
        self.inc_attempts(Some(&reason));
        self.submitted = false;
        if let Some(e) = err {
            warn!(error = ?e, "Repreparing message: {}", reason.clone());
        } else {
            warn!("Repreparing message: {}", reason.clone());
        }
        self.reprepare_or_drop(reason)
    }

    fn on_metadata_wait(&mut self, observation: MetadataWaitObservation) -> PendingOperationResult {
        let reason = ReprepareReason::AwaitingValidatorSignatures;
        self.inc_attempts(Some(&reason));
        self.submitted = false;
        if observation.first_observation {
            warn!(
                wait_seconds = observation.elapsed.as_secs_f64(),
                "Waiting for validator signatures"
            );
        } else {
            debug!(
                wait_seconds = observation.elapsed.as_secs_f64(),
                "Still waiting for validator signatures"
            );
        }
        let result = self.reprepare_or_drop(reason);
        if Self::should_skip(self.num_retries, self.max_retries) {
            self.ctx.metrics.finish_metadata_wait(
                self.message.id(),
                self.app_context.as_deref(),
                false,
            );
        }
        result
    }

    fn reprepare_or_drop(&self, reason: ReprepareReason) -> PendingOperationResult {
        // For fail-fast messages (relay API), drop immediately once the retry budget is
        // exceeded. Without this check, a small max_retries value (e.g. 3) would still
        // hit the fixed early-backoff arms (1 => 5s, 2 => 10s, ...) rather than dropping.
        // Normal relayer messages do NOT set fail_fast and continue to the long-backoff arm.
        if self.fail_fast && self.num_retries >= self.max_retries {
            warn!(
                message_id = ?self.message.id(),
                num_retries = self.num_retries,
                max_retries = self.max_retries,
                "Relay API message exceeded max retries, dropping"
            );
            return PendingOperationResult::Drop;
        }
        PendingOperationResult::Reprepare(reason)
    }

    fn on_reconfirm<E: Debug>(&mut self, err: Option<E>, reason: &str) -> PendingOperationResult {
        self.inc_attempts(None);
        if let Some(e) = err {
            warn!(error = ?e, id = ?self.id(), "Reconfirming message: {}", reason);
        } else {
            warn!(id = ?self.id(), "Reconfirming message: {}", reason);
        }
        PendingOperationResult::NotReady
    }

    /// Record in HyperlaneDB and various metrics that this process has observed
    /// the successful processing of a message. An `Ok(())` value returned by
    /// this function is the 'commit' point in a message's lifetime for
    /// final processing -- after this function has been seen to
    /// `return Ok(())`, then without a wiped HyperlaneDB, we will never
    /// re-attempt processing for this message again, even after the relayer
    /// restarts.
    fn record_message_process_success(&mut self) -> Result<()> {
        if let Some(wait_duration) = self.ctx.metrics.finish_metadata_wait(
            self.message.id(),
            self.app_context.as_deref(),
            true,
        ) {
            info!(
                wait_seconds = wait_duration.as_secs_f64(),
                "Validator signature wait recovered after message delivery"
            );
        }
        self.ctx
            .origin_db
            .store_processed_by_nonce(&self.message.nonce, &true)?;
        self.ctx.metrics.update_nonce(&self.message);
        self.ctx.metrics.messages_processed.inc();
        Ok(())
    }

    fn reset_attempts(&mut self) -> bool {
        self.next_attempt_after = None;
        self.last_attempted_at = Instant::now();
        let status = self.status.clone();
        let state = PendingMessageRetryState::new(self.num_retries, None, None, None);
        if let Err(e) = self
            .ctx
            .origin_db
            .store_pending_message_retry_state_and_status_by_message_id(
                &self.message.id(),
                &state,
                &status,
            )
        {
            warn!(message_id = ?self.message.id(), err = %e, "Persisting manual retry reset failed for message");
            return false;
        }
        true
    }

    fn inc_attempts(&mut self, reason: Option<&ReprepareReason>) {
        self.num_retries = self.num_retries.saturating_add(1);
        self.last_attempted_at = Instant::now();
        let delay = PendingMessage::calculate_msg_backoff(
            self.num_retries,
            self.max_retries,
            Some(self.message.id()),
            reason,
        );
        self.next_attempt_after = delay.and_then(|dur| self.last_attempted_at.checked_add(dur));
        self.persist_retry_state(delay, reason.cloned());
    }

    fn set_retries(&mut self, retries: u32) {
        self.num_retries = retries;
        let reason = match &self.status {
            PendingOperationStatus::Retry(reason) => Some(reason.clone()),
            _ => None,
        };
        let delay = Self::calculate_msg_backoff(
            self.num_retries,
            self.max_retries,
            Some(self.message.id()),
            reason.as_ref(),
        );
        self.next_attempt_after = delay.and_then(|delay| Instant::now().checked_add(delay));
        self.persist_retry_state(delay, reason);
    }

    fn persist_retry_state(&self, delay: Option<Duration>, reason: Option<ReprepareReason>) {
        let next_attempt_at_millis = delay.and_then(|delay| {
            SystemTime::now()
                .checked_add(delay)?
                .duration_since(UNIX_EPOCH)
                .ok()?
                .as_millis()
                .try_into()
                .ok()
        });
        let retry_delay_millis = delay.and_then(|delay| delay.as_millis().try_into().ok());
        let state = PendingMessageRetryState::new(
            self.num_retries,
            next_attempt_at_millis,
            retry_delay_millis,
            reason,
        );
        if let Err(e) = self
            .ctx
            .origin_db
            .store_pending_message_retry_state_by_message_id(&self.message.id(), &state)
        {
            warn!(message_id = ?self.message.id(), err = %e, "Persisting durable retry state failed for message");
        }
    }

    /// Get duration we should wait before re-attempting to deliver a message
    /// given the number of retries.
    /// `pub(crate)` for testing purposes
    pub(crate) fn calculate_msg_backoff(
        num_retries: u32,
        max_retries: u32,
        message_id: Option<H256>,
        reason: Option<&ReprepareReason>,
    ) -> Option<Duration> {
        // Signatures are simply not yet available (validator hasn't signed past the reorg
        // period yet). Use a short 2s fast-path so the relayer can pick them up promptly
        // without repeatedly rebuilding aggregation metadata for up to 20 seconds. Note:
        // num_retries is the total persisted retry counter across all reasons, not a
        // per-reason count.
        //
        // After the fast-path budget is spent, restart the normal gentle ramp (5s→10s→30s…)
        // from the beginning rather than landing mid-table at the 3-min arm.
        if matches!(reason, Some(ReprepareReason::AwaitingValidatorSignatures)) {
            if (1..=VALIDATOR_SIGNATURE_FAST_RETRY_MAX).contains(&num_retries) {
                return Some(VALIDATOR_SIGNATURE_FAST_RETRY_INTERVAL);
            }
            // Offset retries so the first retry after the fast path resumes the normal ramp.
            // Pass reason=None to avoid recursing into this branch again.
            return Self::calculate_msg_backoff(
                num_retries.saturating_sub(VALIDATOR_SIGNATURE_FAST_RETRY_MAX),
                max_retries,
                message_id,
                None,
            );
        }
        Some(Duration::from_secs(match num_retries {
            i if i < 1 => return None,
            1 => 5,
            2 => 10,
            3 => 30,
            4 => 60,
            i if (5..25).contains(&i) => 60u64.saturating_mul(3),
            // linearly increase from 5min to ~25min, adding 1.5min for each additional attempt
            i if (25..40).contains(&i) => 60u64
                .saturating_mul(5)
                .saturating_add((i as u64).saturating_sub(25).saturating_mul(90)),
            // wait 30min for the next 5 attempts
            i if (40..45).contains(&i) => 60u64.saturating_mul(30),
            // wait 60min for the next 5 attempts
            i if (45..50).contains(&i) => 60u64.saturating_mul(60),
            // linearly increase the backoff time, adding 1h for each additional attempt
            i if (50..max_retries).contains(&i) => {
                let hour: u64 = 60u64.saturating_mul(60);
                let two_hours: u64 = hour.saturating_mul(2);
                // To be extra safe, `max` to make sure it's at least 2 hours.
                let target = two_hours
                    .max((num_retries.saturating_sub(49) as u64).saturating_mul(two_hours));
                // Schedule it at some random point in the next 6 hours to
                // avoid scheduling messages with the same # of retries
                // at the exact same time and starve new messages.

                let six_hours = hour.saturating_mul(6);
                let random_val = rand::random::<u64>();
                target.saturating_add(random_val.overflowing_rem(six_hours).0)
            }
            // after `max_message_retries`, the message is considered undeliverable
            // and the backoff is set as far into the future as possible
            _ => {
                if let Some(message_id) = message_id {
                    warn!(
                        message_id = ?message_id,
                        ?max_retries,
                        "Message has been retried too many times, skipping",
                    );
                }
                chrono::Duration::weeks(10).num_seconds() as u64
            }
        }))
    }

    async fn clarify_reason(&self, reason: ReprepareReason) -> Option<ReprepareReason> {
        use ReprepareReason::ApplicationReport;

        match self
            .ctx
            .application_operation_verifier
            .verify(&self.app_context, &self.message)
            .await
        {
            Some(r) => {
                debug!(original = ?reason, report = ?r, app = ?self.app_context, message = ?self.message, "Clarifying reprepare reason with application report");
                Some(ApplicationReport(r.into()))
            }
            None => None,
        }
    }

    /// Builds metadata
    async fn build_metadata(&mut self) -> Result<Metadata, PendingOperationResult> {
        let ism_address = self.recipient_ism_address().await?;

        let message_metadata_builder = match MessageMetadataBuilder::new(
            self.ctx.metadata_builder.clone(),
            ism_address,
            &self.message,
        )
        .await
        {
            Ok(message_metadata_builder) => message_metadata_builder,
            Err(err) => {
                return Err(
                    self.on_reprepare(Some(err), ReprepareReason::ErrorGettingMetadataBuilder)
                );
            }
        };

        let params = MessageMetadataBuildParams::default();

        let build_metadata_start = Instant::now();
        let metadata_res = message_metadata_builder
            .build(ism_address, &self.message, params)
            .await;

        tracing::debug!(?self.message, ?metadata_res, "Metadata build result");

        let metadata_res = match metadata_res {
            Ok(metadata) => {
                if let Some(wait_duration) = self.ctx.metrics.finish_metadata_wait(
                    self.message.id(),
                    self.app_context.as_deref(),
                    true,
                ) {
                    info!(
                        wait_seconds = wait_duration.as_secs_f64(),
                        "Validator signatures became available"
                    );
                }
                Ok(metadata)
            }
            Err(err) => {
                if !matches!(err, MetadataBuildError::AwaitingValidatorSignatures) {
                    self.ctx.metrics.finish_metadata_wait(
                        self.message.id(),
                        self.app_context.as_deref(),
                        false,
                    );
                }
                let reprepare = match &err {
                    MetadataBuildError::FailedToBuild(_) | MetadataBuildError::FastPathError(_) => {
                        self.on_reprepare(Some(&err), ReprepareReason::ErrorBuildingMetadata)
                    }
                    MetadataBuildError::CouldNotFetch => {
                        self.on_reprepare::<String>(None, ReprepareReason::CouldNotFetchMetadata)
                    }
                    // If metadata building is refused, allow it to be retried later.
                    MetadataBuildError::Refused(reason) => {
                        warn!(?reason, "Metadata building refused");
                        self.on_reprepare::<String>(None, ReprepareReason::MessageMetadataRefused)
                    }
                    // These errors cannot be recovered from, so we drop them.
                    MetadataBuildError::UnsupportedModuleType(reason) => {
                        warn!(?reason, "Unsupported module type");
                        self.on_reprepare(Some(&err), ReprepareReason::ErrorBuildingMetadata)
                    }
                    MetadataBuildError::MaxIsmDepthExceeded(depth) => {
                        warn!(depth, "Max ISM depth reached");
                        self.on_reprepare(Some(&err), ReprepareReason::ErrorBuildingMetadata)
                    }
                    MetadataBuildError::MaxIsmCountReached(count) => {
                        warn!(count, "Max ISM count reached");
                        self.on_reprepare(Some(&err), ReprepareReason::ErrorBuildingMetadata)
                    }
                    MetadataBuildError::AggregationThresholdNotMet(threshold) => {
                        warn!(threshold, "Aggregation threshold not met");
                        self.on_reprepare(Some(&err), ReprepareReason::CouldNotFetchMetadata)
                    }
                    MetadataBuildError::MaxValidatorCountReached(count) => {
                        warn!(count, "Max validator count reached");
                        self.on_reprepare(Some(&err), ReprepareReason::ErrorBuildingMetadata)
                    }
                    MetadataBuildError::MerkleRootMismatch {
                        root,
                        canonical_root,
                    } => {
                        warn!(?root, ?canonical_root, "Merkle root mismatch");
                        self.on_reprepare(Some(&err), ReprepareReason::ErrorBuildingMetadata)
                    }
                    MetadataBuildError::AwaitingValidatorSignatures => {
                        let observation = self
                            .ctx
                            .metrics
                            .record_metadata_wait(self.message.id(), self.app_context.as_deref());
                        self.on_metadata_wait(observation)
                    }
                };
                Err(reprepare)
            }
        };
        let build_metadata_end = Instant::now();

        let metrics_params = MetadataBuildMetric {
            app_context: self.app_context.clone(),
            success: metadata_res.is_ok(),
            duration: build_metadata_end.saturating_duration_since(build_metadata_start),
        };

        self.ctx
            .metrics
            .insert_metadata_build_metric(metrics_params);

        metadata_res
    }

    /// clear metadata cache
    fn clear_metadata(&mut self) {
        tracing::debug!(id=?self.message.id(), INVALIDATE_CACHE_METADATA_LOG);
        self.metadata = None;
    }
}

#[cfg(test)]
mod test {
    use std::io::Write;
    use std::{
        sync::Arc,
        time::{Duration, Instant, SystemTime, UNIX_EPOCH},
    };

    use chrono::TimeDelta;
    use hyperlane_base::tests::mock_hyperlane_db::MockHyperlaneDb as MockDb;
    use hyperlane_base::{cache::OptionalCache, db::*};
    use hyperlane_core::*;

    use crate::test_utils::dummy_data::{dummy_message_context, dummy_metadata_builder};

    use super::{PendingMessage, DEFAULT_MAX_MESSAGE_RETRIES, VALIDATOR_SIGNATURE_FAST_RETRY_MAX};

    fn unix_millis(time: SystemTime) -> u64 {
        time.duration_since(UNIX_EPOCH)
            .expect("test time must follow Unix epoch")
            .as_millis()
            .try_into()
            .expect("test timestamp must fit in u64")
    }

    struct RawRetryState(&'static [u8]);

    impl Encode for RawRetryState {
        fn write_to<W: Write>(&self, writer: &mut W) -> std::io::Result<usize> {
            writer.write(self.0)
        }
    }

    #[test]
    fn retry_state_reconciliation_uses_authoritative_count() {
        let message_id = H256::zero();
        let stale_state = PendingMessageRetryState::new(
            1,
            Some(60_000),
            Some(60_000),
            Some(ReprepareReason::CouldNotFetchMetadata),
        );
        assert_eq!(
            PendingMessage::reconcile_retry_state(Some(stale_state), 2, &message_id),
            (2, None)
        );

        let ahead_state = PendingMessageRetryState::new(
            3,
            Some(60_000),
            Some(60_000),
            Some(ReprepareReason::ErrorSubmitting),
        );
        assert_eq!(
            PendingMessage::reconcile_retry_state(Some(ahead_state.clone()), 2, &message_id),
            (3, Some(ahead_state))
        );
    }

    #[test]
    fn restores_remaining_retry_delay_and_bounds_backward_clock_skew() {
        let wall_now = UNIX_EPOCH + Duration::from_secs(1_000);
        let monotonic_now = Instant::now();
        let state = PendingMessageRetryState::new(
            8,
            Some(unix_millis(wall_now + Duration::from_secs(10))),
            Some(60_000),
            Some(ReprepareReason::CouldNotFetchMetadata),
        );

        assert_eq!(
            PendingMessage::restore_retry_deadline(&state, wall_now, monotonic_now),
            monotonic_now.checked_add(Duration::from_secs(10))
        );

        let skewed_wall_now = wall_now - Duration::from_secs(3_600);
        assert_eq!(
            PendingMessage::restore_retry_deadline(&state, skewed_wall_now, monotonic_now),
            monotonic_now.checked_add(Duration::from_secs(60))
        );
    }

    #[test]
    fn expired_retry_deadline_runs_immediately() {
        let wall_now = UNIX_EPOCH + Duration::from_secs(1_000);
        let state = PendingMessageRetryState::new(
            8,
            Some(unix_millis(wall_now - Duration::from_secs(1))),
            Some(60_000),
            Some(ReprepareReason::CouldNotFetchMetadata),
        );

        assert_eq!(
            PendingMessage::restore_retry_deadline(&state, wall_now, Instant::now()),
            None
        );
    }

    #[tokio::test]
    async fn restores_durable_deadline_and_falls_back_from_malformed_state() {
        let origin_domain = HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum);
        let destination_domain = HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum);
        let cache = OptionalCache::new(None);
        let temp_dir = tempfile::tempdir().expect("temp db directory");
        let db = DB::from_path(temp_dir.path()).expect("open temp db");
        let base_db = HyperlaneRocksDB::new(&origin_domain, db);
        let message = HyperlaneMessage {
            nonce: 7,
            origin: KnownHyperlaneDomain::Arbitrum as u32,
            destination: KnownHyperlaneDomain::Ethereum as u32,
            ..Default::default()
        };
        let base_metadata_builder =
            dummy_metadata_builder(&origin_domain, &destination_domain, &base_db, cache.clone());
        let ctx = Arc::new(dummy_message_context(
            Arc::new(base_metadata_builder),
            &base_db,
            cache,
        ));
        let mut pending = PendingMessage::new(
            message.clone(),
            ctx.clone(),
            PendingOperationStatus::FirstPrepareAttempt,
            None,
            DEFAULT_MAX_MESSAGE_RETRIES,
        );
        assert!(matches!(
            pending.on_reprepare::<String>(None, ReprepareReason::CouldNotFetchMetadata),
            PendingOperationResult::Reprepare(ReprepareReason::CouldNotFetchMetadata)
        ));
        let persisted = PendingMessage::maybe_from_persisted_retries(
            message.clone(),
            ctx.clone(),
            None,
            DEFAULT_MAX_MESSAGE_RETRIES,
        )
        .expect("restore production retry state");
        assert_eq!(persisted.get_retries(), 1);
        assert_eq!(
            persisted.status(),
            PendingOperationStatus::Retry(ReprepareReason::CouldNotFetchMetadata)
        );
        assert!(persisted.next_attempt_after().is_some());

        // Simulate rollback to an old binary, which advances only the legacy count,
        // followed by rolling forward to this version.
        base_db
            .store_pending_message_retry_count_by_message_id(&message.id(), &2)
            .expect("advance legacy retry count");
        base_db
            .store_status_by_message_id(
                &message.id(),
                &PendingOperationStatus::Retry(ReprepareReason::ErrorSubmitting),
            )
            .expect("store legacy retry reason");
        let rolled_forward = PendingMessage::maybe_from_persisted_retries(
            message.clone(),
            ctx.clone(),
            None,
            DEFAULT_MAX_MESSAGE_RETRIES,
        )
        .expect("restore after rollback");
        let remaining = rolled_forward
            .next_attempt_after()
            .expect("legacy schedule");
        assert_eq!(rolled_forward.get_retries(), 2);
        assert_eq!(
            rolled_forward.status(),
            PendingOperationStatus::Retry(ReprepareReason::ErrorSubmitting)
        );
        assert!(remaining.duration_since(Instant::now()) <= Duration::from_secs(10));

        // Simulate an old binary applying a manual retry after the v1 record was
        // written at the same count. Roll-forward must not restore its stale deadline.
        let stale_manual_state = PendingMessageRetryState::new(
            2,
            Some(unix_millis(SystemTime::now() + Duration::from_secs(60))),
            Some(60_000),
            Some(ReprepareReason::ErrorSubmitting),
        );
        base_db
            .store_pending_message_retry_state_by_message_id(&message.id(), &stale_manual_state)
            .expect("store stale manual retry state");
        base_db
            .store_status_by_message_id(
                &message.id(),
                &PendingOperationStatus::Retry(ReprepareReason::Manual),
            )
            .expect("store legacy manual status");
        let manual_roll_forward = PendingMessage::maybe_from_persisted_retries(
            message.clone(),
            ctx.clone(),
            None,
            DEFAULT_MAX_MESSAGE_RETRIES,
        )
        .expect("restore legacy manual retry");
        assert_eq!(manual_roll_forward.next_attempt_after(), None);
        assert_eq!(
            manual_roll_forward.status(),
            PendingOperationStatus::Retry(ReprepareReason::Manual)
        );
        let normalized = base_db
            .retrieve_pending_message_retry_state_by_message_id(&message.id())
            .expect("read normalized manual state")
            .expect("normalized manual state");
        assert_eq!(normalized.next_attempt_at_millis, None);
        assert_eq!(normalized.reason, None);

        let deadline = SystemTime::now() + Duration::from_secs(60);
        let state = PendingMessageRetryState::new(
            3,
            Some(unix_millis(deadline)),
            Some(60_000),
            Some(ReprepareReason::CouldNotFetchMetadata),
        );
        base_db
            .store_pending_message_retry_state_by_message_id(&message.id(), &state)
            .expect("store retry state");
        // Simulate the historical write-order fault where the combined state landed
        // before its legacy mirror. The higher combined count must remain authoritative.
        base_db
            .store_pending_message_retry_count_by_message_id(&message.id(), &2)
            .expect("store lagging legacy retry count");

        let mut restored = PendingMessage::maybe_from_persisted_retries(
            message.clone(),
            ctx.clone(),
            None,
            DEFAULT_MAX_MESSAGE_RETRIES,
        )
        .expect("restore pending message");
        let remaining = restored
            .next_attempt_after()
            .expect("future deadline")
            .duration_since(Instant::now());
        assert_eq!(restored.get_retries(), 3);
        assert_eq!(
            restored.status(),
            PendingOperationStatus::Retry(ReprepareReason::CouldNotFetchMetadata)
        );
        assert!(remaining > Duration::from_secs(58));
        assert!(remaining <= Duration::from_secs(60));

        restored.set_status(PendingOperationStatus::Retry(ReprepareReason::Manual));
        assert!(restored.reset_attempts());
        assert_eq!(
            base_db
                .retrieve_status_by_message_id(&message.id())
                .expect("read manual retry status"),
            Some(PendingOperationStatus::Retry(ReprepareReason::Manual))
        );
        let manual_state = base_db
            .retrieve_pending_message_retry_state_by_message_id(&message.id())
            .expect("read manual retry state")
            .expect("manual retry state");
        assert_eq!(manual_state.retry_count, 3);
        assert_eq!(manual_state.next_attempt_at_millis, None);
        assert_eq!(manual_state.retry_delay_millis, None);
        assert_eq!(manual_state.reason, None);
        let manual = PendingMessage::maybe_from_persisted_retries(
            message.clone(),
            ctx.clone(),
            None,
            DEFAULT_MAX_MESSAGE_RETRIES,
        )
        .expect("restore manual retry");
        assert_eq!(
            manual.status(),
            PendingOperationStatus::Retry(ReprepareReason::Manual)
        );
        assert_eq!(manual.next_attempt_after(), None);

        let expired_state = PendingMessageRetryState::new(
            3,
            Some(unix_millis(SystemTime::now() - Duration::from_secs(1))),
            Some(60_000),
            Some(ReprepareReason::CouldNotFetchMetadata),
        );
        base_db
            .store_pending_message_retry_state_by_message_id(&message.id(), &expired_state)
            .expect("store expired retry state");
        let expired = PendingMessage::maybe_from_persisted_retries(
            message.clone(),
            ctx.clone(),
            None,
            DEFAULT_MAX_MESSAGE_RETRIES,
        )
        .expect("restore expired pending message");
        assert_eq!(expired.get_retries(), 3);
        assert_eq!(expired.next_attempt_after(), None);

        base_db
            .store_value_by_key(
                "pending_message_retry_state_for_message_id_v1_",
                &message.id(),
                &H256::zero(),
            )
            .expect("store malformed retry state");
        base_db
            .store_pending_message_retry_count_by_message_id(&message.id(), &2)
            .expect("store legacy retry count");
        let fallback = PendingMessage::maybe_from_persisted_retries(
            message,
            ctx,
            None,
            DEFAULT_MAX_MESSAGE_RETRIES,
        )
        .expect("fallback to legacy retry state");
        assert_eq!(fallback.get_retries(), 2);
        assert!(fallback.next_attempt_after().is_some());

        let message = fallback.message.clone();
        let ctx = fallback.ctx.clone();
        base_db
            .store_value_by_key(
                "pending_message_retry_state_for_message_id_v1_",
                &message.id(),
                &RawRetryState(
                    br#"{"version":2,"retry_count":9,"next_attempt_at_millis":null,"retry_delay_millis":null,"reason":null}"#,
                ),
            )
            .expect("store unsupported retry state");
        base_db
            .store_pending_message_retry_count_by_message_id(&message.id(), &3)
            .expect("store fallback retry count");
        let mut unsupported = PendingMessage::maybe_from_persisted_retries(
            message.clone(),
            ctx.clone(),
            None,
            DEFAULT_MAX_MESSAGE_RETRIES,
        )
        .expect("fallback from unsupported retry state");
        assert_eq!(unsupported.get_retries(), 3);
        assert!(unsupported.next_attempt_after().is_some());

        // An intentional lower/manual reset must replace both records; otherwise
        // monotonic reconciliation would resurrect the older higher v1 count.
        unsupported.set_retries(0);
        assert_eq!(
            base_db
                .retrieve_pending_message_retry_count_by_message_id(&message.id())
                .expect("read reset legacy count"),
            Some(0)
        );
        assert_eq!(
            base_db
                .retrieve_pending_message_retry_state_by_message_id(&message.id())
                .expect("read reset durable state")
                .expect("reset durable state")
                .retry_count,
            0
        );
        let reset = PendingMessage::maybe_from_persisted_retries(
            message,
            ctx,
            None,
            DEFAULT_MAX_MESSAGE_RETRIES,
        )
        .expect("restore manually reset state");
        assert_eq!(reset.get_retries(), 0);
        assert_eq!(reset.next_attempt_after(), None);
    }

    #[test]
    fn test_calculate_msg_backoff_does_not_overflow() {
        use super::PendingMessage;
        use std::time::Duration;
        let ten_weeks_from_now = Instant::now()
            + Duration::from_secs(
                chrono::Duration::weeks(10)
                    .num_seconds()
                    .try_into()
                    .unwrap(),
            );

        // this is really an overflow check
        let next_prepare_attempt = PendingMessage::next_attempt_after(
            DEFAULT_MAX_MESSAGE_RETRIES,
            DEFAULT_MAX_MESSAGE_RETRIES,
            None,
        )
        .unwrap();

        // the backoff should be at least 10 weeks into the future
        assert!(next_prepare_attempt.gt(&ten_weeks_from_now));
    }

    #[test]
    fn db_num_retries_are_some_when_not_skipping() {
        let mock_retries = 10;
        let expected_retries = Some(mock_retries);
        let max_retries = DEFAULT_MAX_MESSAGE_RETRIES;

        // retry count is the same, because `max_retries` is `None`
        assert_get_num_retries(mock_retries, expected_retries, max_retries);
    }

    #[test]
    fn db_high_num_retries_are_not_loaded() {
        let mock_retries = u32::MAX;
        let expected_retries = None;
        let max_retries = u32::MAX;

        // retry count is >= than the skipping threshold so it's not loaded
        assert_get_num_retries(mock_retries, expected_retries, max_retries);
    }

    #[test]
    fn db_low_num_retries_are_loaded() {
        let mock_retries = 1;
        let expected_retries = Some(1);
        let max_retries = u32::MAX;

        // retry count is the same, because `max_retries` is `None`
        assert_get_num_retries(mock_retries, expected_retries, max_retries);
    }

    #[test]
    fn test_calculate_msg_backoff_non_decreasing() {
        let mut cumulative = Duration::from_secs(0);
        let mut last_backoff = Duration::from_secs(0);

        // Intentionally only up to 50 because after that we add some randomness that'll cause this test to flake
        for i in 0..=50 {
            let backoff_duration = PendingMessage::calculate_msg_backoff(i, u32::MAX, None, None)
                .unwrap_or(Duration::from_secs(0));
            // Uncomment to show the impact of changes to the backoff duration:

            // println!(
            //     "Retry #{}: cumulative duration from beginning is {}, since last attempt is {}",
            //     i,
            //     duration_fmt(&cumulative),
            //     duration_fmt(&backoff_duration)
            // );
            cumulative += backoff_duration;

            assert!(backoff_duration >= last_backoff);
            last_backoff = backoff_duration;
        }
    }

    #[allow(dead_code)]
    fn duration_fmt(duration: &Duration) -> String {
        let duration_total_secs = duration.as_secs();
        let seconds = duration_total_secs % 60;
        let minutes = (duration_total_secs / 60) % 60;
        let hours = (duration_total_secs / 60) / 60;
        format!("{hours}:{minutes}:{seconds}")
    }

    fn dummy_db_with_retries(retries: u32) -> MockDb {
        let mut db = MockDb::new();
        db.expect_retrieve_pending_message_retry_count_by_message_id()
            .returning(move |_| Ok(Some(retries)));
        db
    }

    fn assert_get_num_retries(mock_retries: u32, expected_retries: Option<u32>, max_retries: u32) {
        let db = dummy_db_with_retries(mock_retries);
        let num_retries = PendingMessage::get_retries_or_skip(
            Arc::new(db),
            &HyperlaneMessage::default(),
            max_retries,
        );

        assert_eq!(num_retries, expected_retries);
    }

    #[test]
    fn test_awaiting_validator_signatures_backoff() {
        let reason = ReprepareReason::AwaitingValidatorSignatures;

        // Fast path: the bounded initial retries always return 2s.
        for i in 1..=VALIDATOR_SIGNATURE_FAST_RETRY_MAX {
            assert_eq!(
                PendingMessage::calculate_msg_backoff(
                    i,
                    DEFAULT_MAX_MESSAGE_RETRIES,
                    None,
                    Some(&reason)
                ),
                Some(Duration::from_secs(2)),
                "retry {i} should be 2s"
            );
        }

        // After the fast path, resume the gentle ramp from its first step.
        let first_normal_retry = VALIDATOR_SIGNATURE_FAST_RETRY_MAX.saturating_add(1);
        assert_eq!(
            PendingMessage::calculate_msg_backoff(
                first_normal_retry,
                DEFAULT_MAX_MESSAGE_RETRIES,
                None,
                Some(&reason)
            ),
            Some(Duration::from_secs(5)),
            "first retry after the fast path should resume the normal ramp at 5s"
        );
        assert_eq!(
            PendingMessage::calculate_msg_backoff(
                first_normal_retry.saturating_add(1),
                DEFAULT_MAX_MESSAGE_RETRIES,
                None,
                Some(&reason)
            ),
            Some(Duration::from_secs(10)),
        );
        assert_eq!(
            PendingMessage::calculate_msg_backoff(
                first_normal_retry.saturating_add(2),
                DEFAULT_MAX_MESSAGE_RETRIES,
                None,
                Some(&reason)
            ),
            Some(Duration::from_secs(30)),
        );
    }

    /// Make sure DEFAULT_MAX_MESSAGE_RETRIES takes around 2 weeks to reach
    /// so that messages doesn't getting dropped earlier than expected
    #[test]
    fn check_default_max_message_retries() {
        let total_backoff_duration: Duration = (0..DEFAULT_MAX_MESSAGE_RETRIES)
            .filter_map(|i| {
                PendingMessage::calculate_msg_backoff(i, DEFAULT_MAX_MESSAGE_RETRIES, None, None)
            })
            .sum();

        // Have a window that is acceptable for "around 2 weeks".
        // The backoff calculation adds random jitter of 0-6 hours for retries 50-65
        // (16 retries), giving up to 96 hours of variance. Use ±5 days tolerance
        // to account for this randomness.
        let max_backoff_duration = chrono::Duration::weeks(2)
            .checked_add(&TimeDelta::days(5))
            .expect("Failed to compute duration")
            .to_std()
            .expect("Failed to convert TimeDelta to Duration");
        let min_backoff_duration = chrono::Duration::weeks(2)
            .checked_sub(&TimeDelta::days(5))
            .expect("Failed to compute duration")
            .to_std()
            .expect("Failed to convert TimeDelta to Duration");

        assert!(total_backoff_duration < max_backoff_duration);
        assert!(total_backoff_duration > min_backoff_duration);
    }

    /// Chainlink's CCIP is known to take upwards of 25mins to
    /// process.
    /// So make sure we have a couple of retries around 25-30min range.
    /// In this test case, we define "couple of retries" = 2
    #[test]
    fn check_ccip_retry() {
        let backoff_durations: Vec<Duration> = (0..DEFAULT_MAX_MESSAGE_RETRIES)
            .filter_map(|i| {
                PendingMessage::calculate_msg_backoff(i, DEFAULT_MAX_MESSAGE_RETRIES, None, None)
            })
            .collect();

        let cumulative_backoff_durations: Vec<Duration> = backoff_durations
            .into_iter()
            .scan(Duration::from_secs(0), |acc, x| {
                *acc += x;
                Some(*acc)
            })
            .collect();

        // 25 mins
        let min_backoff_duration = Duration::from_secs(60 * 25);
        // 30 mins
        let max_backoff_duration = Duration::from_secs(60 * 30);

        let num_retries_in_range = cumulative_backoff_durations
            .into_iter()
            .filter(|d| *d >= min_backoff_duration && *d <= max_backoff_duration)
            .count();

        assert_eq!(num_retries_in_range, 2);
    }

    #[tokio::test]
    async fn check_stored_status() {
        let origin_domain = HyperlaneDomain::Known(hyperlane_core::KnownHyperlaneDomain::Arbitrum);
        let destination_domain =
            HyperlaneDomain::Known(hyperlane_core::KnownHyperlaneDomain::Arbitrum);
        let cache = OptionalCache::new(None);

        let temp_dir = tempfile::tempdir().unwrap();
        let db = DB::from_path(temp_dir.path()).unwrap();
        let base_db = HyperlaneRocksDB::new(&origin_domain, db);

        let message = HyperlaneMessage {
            nonce: 0,
            origin: KnownHyperlaneDomain::Arbitrum as u32,
            destination: KnownHyperlaneDomain::Arbitrum as u32,
            ..Default::default()
        };

        let base_metadata_builder =
            dummy_metadata_builder(&origin_domain, &destination_domain, &base_db, cache.clone());
        let message_context =
            dummy_message_context(Arc::new(base_metadata_builder), &base_db, cache);

        let mut pending_message = PendingMessage::new(
            message.clone(),
            Arc::new(message_context),
            PendingOperationStatus::FirstPrepareAttempt,
            Some(format!("test-{}", 0)),
            2,
        );

        let expected_status = PendingOperationStatus::ReadyToSubmit;
        pending_message.set_status(expected_status.clone());

        let db_status = pending_message
            .ctx
            .origin_db
            .retrieve_status_by_message_id(&pending_message.id())
            .expect("Failed to fetch message status")
            .expect("Message status not found");

        assert_eq!(db_status, expected_status);
    }

    #[test]
    fn check_debug_print() {
        let origin_domain = HyperlaneDomain::Known(hyperlane_core::KnownHyperlaneDomain::Arbitrum);
        let destination_domain =
            HyperlaneDomain::Known(hyperlane_core::KnownHyperlaneDomain::Arbitrum);
        let cache = OptionalCache::new(None);

        let temp_dir = tempfile::tempdir().unwrap();
        let db = DB::from_path(temp_dir.path()).unwrap();
        let base_db = HyperlaneRocksDB::new(&origin_domain, db);

        let message = HyperlaneMessage {
            nonce: 0,
            origin: KnownHyperlaneDomain::Arbitrum as u32,
            destination: KnownHyperlaneDomain::Arbitrum as u32,
            ..Default::default()
        };

        let base_metadata_builder =
            dummy_metadata_builder(&origin_domain, &destination_domain, &base_db, cache.clone());
        let message_context =
            dummy_message_context(Arc::new(base_metadata_builder), &base_db, cache);

        let pending_message = PendingMessage::new(
            message.clone(),
            Arc::new(message_context),
            PendingOperationStatus::FirstPrepareAttempt,
            Some(format!("test-{}", 0)),
            2,
        );

        let pending_message_debug = format!("{pending_message:?}");
        let expected = r#"PendingMessage { num_retries: 0, since_last_attempt_s: 0, next_attempt_after_s: 0, message_id: 0xaeafdd9f018e66a50d30bb141184d10e57bd956e839f70213c163eb41a3c0d87, status: FirstPrepareAttempt, app_context: Some("test-0") }"#;
        assert_eq!(pending_message_debug, expected);
    }

    #[test]
    fn metadata_wait_ends_at_normal_message_retry_limit() {
        let origin_domain = HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum);
        let destination_domain = HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum);
        let cache = OptionalCache::new(None);
        let temp_dir = tempfile::tempdir().unwrap();
        let db = DB::from_path(temp_dir.path()).unwrap();
        let base_db = HyperlaneRocksDB::new(&origin_domain, db);
        let message = HyperlaneMessage {
            origin: KnownHyperlaneDomain::Arbitrum as u32,
            destination: KnownHyperlaneDomain::Arbitrum as u32,
            ..Default::default()
        };
        let message_id = message.id();
        let app_context = "test-app";
        let base_metadata_builder =
            dummy_metadata_builder(&origin_domain, &destination_domain, &base_db, cache.clone());
        let message_context =
            dummy_message_context(Arc::new(base_metadata_builder), &base_db, cache);
        let mut pending_message = PendingMessage::new(
            message,
            Arc::new(message_context),
            PendingOperationStatus::FirstPrepareAttempt,
            Some(app_context.to_owned()),
            1,
        );
        let labels = [app_context, "ethereum", "arbitrum"];
        let observation = pending_message
            .ctx
            .metrics
            .record_metadata_wait(message_id, Some(app_context));

        let result = pending_message.on_metadata_wait(observation);

        assert!(matches!(result, PendingOperationResult::Reprepare(_)));
        assert_eq!(
            pending_message
                .ctx
                .metrics
                .metadata_wait_active
                .with_label_values(&labels)
                .get(),
            0
        );
        assert_eq!(
            pending_message
                .ctx
                .metrics
                .metadata_wait_oldest_timestamp_seconds
                .with_label_values(&labels)
                .get(),
            0
        );
        assert_eq!(
            pending_message
                .ctx
                .metrics
                .metadata_wait_event_count
                .with_label_values(&[app_context, "ethereum", "arbitrum", "ended"])
                .get(),
            1
        );
    }
}
