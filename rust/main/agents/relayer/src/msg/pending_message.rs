#![allow(clippy::clone_on_ref_ptr)] // TODO: `rustc` 1.80.1 clippy issue

use std::{
    fmt::{Debug, Formatter},
    sync::Arc,
    time::{Duration, Instant},
};

use async_trait::async_trait;
use derive_new::new;
use eyre::Result;
use prometheus::{IntCounter, IntGauge};
use serde::Serialize;
use tracing::{debug, error, info, info_span, instrument, trace, warn, Instrument, Level};

use hyperlane_base::{db::HyperlaneDb, CoreMetrics};
use hyperlane_core::{
    gas_used_by_operation, BatchItem, ChainCommunicationError, ChainResult, ConfirmReason,
    HyperlaneChain, HyperlaneDomain, HyperlaneMessage, Mailbox, MessageSubmissionData,
    PendingOperation, PendingOperationResult, PendingOperationStatus, ReprepareReason, TryBatchAs,
    TxOutcome, H256, U256,
};
use hyperlane_operation_verifier::ApplicationOperationVerifier;

use super::{
    gas_payment::{GasPaymentEnforcer, GasPolicyStatus},
    metadata::{BaseMetadataBuilder, MessageMetadataBuilder, Metadata, MetadataBuilder},
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

/// The message context contains the links needed to submit a message. Each
/// instance is for a unique origin -> destination pairing.
pub struct MessageContext {
    /// Mailbox on the destination chain.
    pub destination_mailbox: Arc<dyn Mailbox>,
    /// Origin chain database to verify gas payments.
    pub origin_db: Arc<dyn HyperlaneDb>,
    /// Used to construct the ISM metadata needed to verify a message from the
    /// origin.
    pub metadata_builder: Arc<BaseMetadataBuilder>,
    /// Used to determine if messages from the origin have made sufficient gas
    /// payments.
    pub origin_gas_payment_enforcer: Arc<GasPaymentEnforcer>,
    /// Hard limit on transaction gas when submitting a transaction to the
    /// destination.
    pub transaction_gas_limit: Option<U256>,
    pub metrics: MessageSubmissionMetrics,
    /// Application operation verifier
    pub application_operation_verifier: Option<Arc<dyn ApplicationOperationVerifier>>,
}

/// A message that the submitter can and should try to submit.
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
    submission_data: Option<Box<MessageSubmissionData>>,
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
    metadata: Option<Vec<u8>>,
    #[new(default)]
    #[serde(skip_serializing)]
    metric: Option<Arc<IntGauge>>,
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
        write!(f, "PendingMessage {{ num_retries: {}, since_last_attempt_s: {last_attempt}, next_attempt_after_s: {next_attempt}, message: {:?}, status: {:?}, app_context: {:?} }}",
               self.num_retries, self.message, self.status, self.app_context)
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
        if let Err(e) = self
            .ctx
            .origin_db
            .store_status_by_message_id(&self.message.id(), &self.status)
        {
            warn!(message_id = ?self.message.id(), err = %e, status = %self.status, "Persisting `status` failed for message");
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
            self.submitted = true;
            self.set_next_attempt_after(CONFIRM_DELAY);
            return PendingOperationResult::Confirm(ConfirmReason::AlreadySubmitted);
        }

        let provider = self.ctx.destination_mailbox.provider();

        // We cannot deliver to an address that is not a contract so check and drop if it isn't.
        let is_contract = match provider.is_contract(&self.message.recipient).await {
            Ok(is_contract) => is_contract,
            Err(err) => {
                return self.on_reprepare(
                    Some(err),
                    ReprepareReason::ErrorCheckingIfRecipientIsContract,
                );
            }
        };
        if !is_contract {
            info!(
                recipient=?self.message.recipient,
                "Dropping message because recipient is not a contract"
            );
            return PendingOperationResult::Drop;
        }

        let ism_address = match self
            .ctx
            .destination_mailbox
            .recipient_ism(self.message.recipient)
            .await
        {
            Ok(ism_address) => ism_address,
            Err(err) => {
                return self.on_reprepare(Some(err), ReprepareReason::ErrorFetchingIsmAddress);
            }
        };

        let message_metadata_builder = match MessageMetadataBuilder::new(
            ism_address,
            &self.message,
            self.ctx.metadata_builder.clone(),
        )
        .await
        {
            Ok(message_metadata_builder) => message_metadata_builder,
            Err(err) => {
                return self.on_reprepare(Some(err), ReprepareReason::ErrorGettingMetadataBuilder);
            }
        };

        let metadata = match message_metadata_builder
            .build(ism_address, &self.message)
            .await
        {
            Ok(metadata) => metadata,
            Err(err) => {
                return self.on_reprepare(Some(err), ReprepareReason::ErrorBuildingMetadata);
            }
        };

        let metadata_bytes = match metadata {
            Metadata::Found(metadata_bytes) => {
                self.metadata = Some(metadata_bytes.clone());
                metadata_bytes
            }
            Metadata::CouldNotFetch => {
                return self.on_reprepare::<String>(None, ReprepareReason::CouldNotFetchMetadata);
            }
            // If the metadata building is refused, we still allow it to be retried later.
            Metadata::Refused(reason) => {
                warn!(?reason, "Metadata building refused");
                return self.on_reprepare::<String>(None, ReprepareReason::MessageMetadataRefused);
            }
        };

        // Estimate transaction costs for the process call. If there are issues, it's
        // likely that gas estimation has failed because the message is
        // reverting. This is defined behavior, so we just log the error and
        // move onto the next tick.
        let tx_cost_estimate = match self
            .ctx
            .destination_mailbox
            .process_estimate_costs(&self.message, &metadata_bytes)
            .await
        {
            Ok(tx_cost_estimate) => tx_cost_estimate,
            Err(err) => {
                let reason = self
                    .clarify_reason(ReprepareReason::ErrorEstimatingGas)
                    .await
                    .unwrap_or(ReprepareReason::ErrorEstimatingGas);
                return self.on_reprepare(Some(err), reason);
            }
        };

        // If the gas payment requirement hasn't been met, move to the next tick.
        let gas_limit = match self
            .ctx
            .origin_gas_payment_enforcer
            .message_meets_gas_payment_requirement(&self.message, &tx_cost_estimate)
            .await
        {
            Ok(gas_limit) => gas_limit,
            Err(err) => {
                return self.on_reprepare(Some(err), ReprepareReason::ErrorCheckingGasRequirement);
            }
        };

        let gas_limit = match gas_limit {
            GasPolicyStatus::NoPaymentFound => {
                return self.on_reprepare::<String>(None, ReprepareReason::GasPaymentNotFound)
            }
            GasPolicyStatus::PolicyNotMet => {
                return self
                    .on_reprepare::<String>(None, ReprepareReason::GasPaymentRequirementNotMet)
            }
            GasPolicyStatus::PolicyMet(gas_limit) => gas_limit,
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
                return self.on_reprepare::<String>(None, ReprepareReason::ExceedsMaxGasLimit);
            }
        }

        self.submission_data = Some(Box::new(MessageSubmissionData {
            metadata: metadata_bytes,
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
        if let Some(metadata) = self.metadata.as_ref() {
            if self
                .ctx
                .destination_mailbox
                .process_estimate_costs(&self.message, metadata)
                .await
                .is_err()
            {
                let reason = self
                    .clarify_reason(ReprepareReason::ErrorEstimatingGas)
                    .await
                    .unwrap_or(ReprepareReason::ErrorEstimatingGas);
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
                self.set_operation_outcome(outcome, state.gas_limit);
                PendingOperationResult::Confirm(ConfirmReason::SubmittedBySelf)
            }
            Err(e) => {
                error!(error=?e, "Error when processing message");
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
            info!(
                submission=?self.submission_outcome,
                "Message successfully processed"
            );
            PendingOperationResult::Success
        } else {
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

    fn set_operation_outcome(
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
        self.next_attempt_after = Some(Instant::now() + delay);
    }

    fn reset_attempts(&mut self) {
        self.reset_attempts();
    }

    fn set_retries(&mut self, retries: u32) {
        self.set_retries(retries);
    }

    fn try_get_mailbox(&self) -> Option<Arc<dyn Mailbox>> {
        Some(self.ctx.destination_mailbox.clone())
    }

    fn get_metric(&self) -> Option<Arc<IntGauge>> {
        self.metric.clone()
    }

    fn set_metric(&mut self, metric: Arc<IntGauge>) {
        self.metric = Some(metric);
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
        let num_retries = Self::get_retries_or_skip(ctx.origin_db.clone(), &message, max_retries)?;
        let message_status = Self::get_message_status(ctx.origin_db.clone(), &message);
        let mut pending_message = Self::new(message, ctx, message_status, app_context, max_retries);
        if num_retries > 0 {
            let next_attempt_after = Self::next_attempt_after(num_retries, max_retries);
            pending_message.num_retries = num_retries;
            pending_message.next_attempt_after = next_attempt_after;
        }
        Some(pending_message)
    }

    fn next_attempt_after(num_retries: u32, max_retries: u32) -> Option<Instant> {
        PendingMessage::calculate_msg_backoff(num_retries, max_retries, None)
            .map(|dur| Instant::now() + dur)
    }

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
            tracing::event!(
                if cfg!(feature = "test-utils") {
                    Level::DEBUG
                } else {
                    Level::TRACE
                },
                ?status,
                id=?message.id(),
                RETRIEVED_MESSAGE_LOG,
            );
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

    fn on_reprepare<E: Debug>(
        &mut self,
        err: Option<E>,
        reason: ReprepareReason,
    ) -> PendingOperationResult {
        self.inc_attempts();
        self.submitted = false;
        if let Some(e) = err {
            warn!(error = ?e, "Repreparing message: {}", reason.clone());
        } else {
            warn!("Repreparing message: {}", reason.clone());
        }
        PendingOperationResult::Reprepare(reason)
    }

    fn on_reconfirm<E: Debug>(&mut self, err: Option<E>, reason: &str) -> PendingOperationResult {
        self.inc_attempts();
        if let Some(e) = err {
            warn!(error = ?e, id = ?self.id(), "Reconfirming message: {}", reason);
        } else {
            warn!(id = ?self.id(), "Reconfirming message: {}", reason);
        }
        PendingOperationResult::NotReady
    }

    fn is_ready(&self) -> bool {
        self.next_attempt_after
            .map(|a| Instant::now() >= a)
            .unwrap_or(true)
    }

    /// Record in HyperlaneDB and various metrics that this process has observed
    /// the successful processing of a message. An `Ok(())` value returned by
    /// this function is the 'commit' point in a message's lifetime for
    /// final processing -- after this function has been seen to
    /// `return Ok(())`, then without a wiped HyperlaneDB, we will never
    /// re-attempt processing for this message again, even after the relayer
    /// restarts.
    fn record_message_process_success(&mut self) -> Result<()> {
        self.ctx
            .origin_db
            .store_processed_by_nonce(&self.message.nonce, &true)?;
        self.ctx.metrics.update_nonce(&self.message);
        self.ctx.metrics.messages_processed.inc();
        Ok(())
    }

    fn reset_attempts(&mut self) {
        self.next_attempt_after = None;
        self.last_attempted_at = Instant::now();
    }

    fn inc_attempts(&mut self) {
        self.set_retries(self.num_retries + 1);
        self.last_attempted_at = Instant::now();
        self.next_attempt_after = PendingMessage::calculate_msg_backoff(
            self.num_retries,
            self.max_retries,
            Some(self.message.id()),
        )
        .map(|dur| self.last_attempted_at + dur);
    }

    fn set_retries(&mut self, retries: u32) {
        self.num_retries = retries;
        self.persist_retries();
    }

    fn persist_retries(&self) {
        if let Err(e) = self
            .ctx
            .origin_db
            .store_pending_message_retry_count_by_message_id(&self.message.id(), &self.num_retries)
        {
            warn!(message_id = ?self.message.id(), err = %e, "Persisting the `num_retries` failed for message");
        }
    }

    /// Get duration we should wait before re-attempting to deliver a message
    /// given the number of retries.
    /// `pub(crate)` for testing purposes
    pub(crate) fn calculate_msg_backoff(
        num_retries: u32,
        max_retries: u32,
        message_id: Option<H256>,
    ) -> Option<Duration> {
        Some(Duration::from_secs(match num_retries {
            i if i < 1 => return None,
            i if (1..10).contains(&i) => 10,
            i if (10..15).contains(&i) => 90,
            i if (15..25).contains(&i) => 60 * 2,
            // linearly increase from 2min to ~25min, adding 1.5min for each additional attempt
            i if (25..40).contains(&i) => (i as u64 - 23) * 90,
            // wait 30min for the next 5 attempts
            i if (40..45).contains(&i) => 60 * 30,
            // wait 60min for the next 5 attempts
            i if (45..50).contains(&i) => 60 * 60,
            // linearly increase the backoff time, adding 1h for each additional attempt
            i if (50..max_retries).contains(&i) => {
                let hour: u64 = 60 * 60;
                let two_hours: u64 = hour * 2;
                // To be extra safe, `max` to make sure it's at least 2 hours.
                let target = two_hours.max((num_retries - 49) as u64 * two_hours);
                // Schedule it at some random point in the next 6 hours to
                // avoid scheduling messages with the same # of retries
                // at the exact same time and starve new messages.
                target + (rand::random::<u64>() % (6 * hour))
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
            .as_ref()?
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
}

#[derive(Debug)]
pub struct MessageSubmissionMetrics {
    // Fields are public for testing purposes
    pub last_known_nonce: IntGauge,
    pub messages_processed: IntCounter,
}

impl MessageSubmissionMetrics {
    pub fn new(
        metrics: &CoreMetrics,
        origin: &HyperlaneDomain,
        destination: &HyperlaneDomain,
    ) -> Self {
        let origin = origin.name();
        let destination = destination.name();
        Self {
            last_known_nonce: metrics.last_known_message_nonce().with_label_values(&[
                "message_processed",
                origin,
                destination,
            ]),
            messages_processed: metrics
                .messages_processed_count()
                .with_label_values(&[origin, destination]),
        }
    }

    fn update_nonce(&self, msg: &HyperlaneMessage) {
        // this is technically a race condition between `.get` and `.set` but worst case
        // the gauge should get corrected on the next update and is not an issue
        // with a ST runtime
        self.last_known_nonce
            .set(std::cmp::max(self.last_known_nonce.get(), msg.nonce as i64));
    }
}

#[cfg(test)]
mod test {
    use std::{
        fmt::Debug,
        sync::Arc,
        time::{Duration, Instant},
    };

    use hyperlane_base::db::*;
    use hyperlane_core::*;

    use crate::msg::pending_message::DEFAULT_MAX_MESSAGE_RETRIES;

    use super::PendingMessage;

    mockall::mock! {
        pub Db {
            fn provider(&self) -> Box<dyn HyperlaneProvider>;
        }

        impl Debug for Db {
            fn fmt<'a>(&self, f: &mut std::fmt::Formatter<'a>) -> std::fmt::Result;
        }

        impl HyperlaneDb for Db {
            fn retrieve_highest_seen_message_nonce(&self) -> DbResult<Option<u32>>;
            fn retrieve_message_by_nonce(&self, nonce: u32) -> DbResult<Option<HyperlaneMessage>>;
            fn retrieve_processed_by_nonce(&self, nonce: &u32) -> DbResult<Option<bool>>;
            fn domain(&self) -> &HyperlaneDomain;
            fn store_message_id_by_nonce(&self, nonce: &u32, id: &H256) -> DbResult<()>;
            fn retrieve_message_id_by_nonce(&self, nonce: &u32) -> DbResult<Option<H256>>;
            fn store_message_by_id(&self, id: &H256, message: &HyperlaneMessage) -> DbResult<()>;
            fn retrieve_message_by_id(&self, id: &H256) -> DbResult<Option<HyperlaneMessage>>;
            fn store_dispatched_block_number_by_nonce(
                &self,
                nonce: &u32,
                block_number: &u64,
            ) -> DbResult<()>;
            fn retrieve_dispatched_block_number_by_nonce(&self, nonce: &u32) -> DbResult<Option<u64>>;
            fn store_processed_by_nonce(&self, nonce: &u32, processed: &bool) -> DbResult<()>;
            fn store_processed_by_gas_payment_meta(
                &self,
                meta: &InterchainGasPaymentMeta,
                processed: &bool,
            ) -> DbResult<()>;
            fn retrieve_processed_by_gas_payment_meta(
                &self,
                meta: &InterchainGasPaymentMeta,
            ) -> DbResult<Option<bool>>;
            fn store_interchain_gas_expenditure_data_by_message_id(
                &self,
                message_id: &H256,
                data: &InterchainGasExpenditureData,
            ) -> DbResult<()>;
            fn retrieve_interchain_gas_expenditure_data_by_message_id(
                &self,
                message_id: &H256,
            ) -> DbResult<Option<InterchainGasExpenditureData>>;
            fn store_status_by_message_id(
                &self,
                message_id: &H256,
                status: &PendingOperationStatus,
            ) -> DbResult<()>;
            fn retrieve_status_by_message_id(
                &self,
                message_id: &H256,
            ) -> DbResult<Option<PendingOperationStatus>>;
            fn store_interchain_gas_payment_data_by_gas_payment_key(
                &self,
                key: &GasPaymentKey,
                data: &InterchainGasPaymentData,
            ) -> DbResult<()>;
            fn retrieve_interchain_gas_payment_data_by_gas_payment_key(
                &self,
                key: &GasPaymentKey,
            ) -> DbResult<Option<InterchainGasPaymentData>>;
            fn store_gas_payment_by_sequence(
                &self,
                sequence: &u32,
                payment: &InterchainGasPayment,
            ) -> DbResult<()>;
            fn retrieve_gas_payment_by_sequence(
                &self,
                sequence: &u32,
            ) -> DbResult<Option<InterchainGasPayment>>;
            fn store_gas_payment_block_by_sequence(
                &self,
                sequence: &u32,
                block_number: &u64,
            ) -> DbResult<()>;
            fn retrieve_gas_payment_block_by_sequence(&self, sequence: &u32) -> DbResult<Option<u64>>;
            fn store_pending_message_retry_count_by_message_id(
                &self,
                message_id: &H256,
                count: &u32,
            ) -> DbResult<()>;
            fn retrieve_pending_message_retry_count_by_message_id(
                &self,
                message_id: &H256,
            ) -> DbResult<Option<u32>>;
            fn store_merkle_tree_insertion_by_leaf_index(
                &self,
                leaf_index: &u32,
                insertion: &MerkleTreeInsertion,
            ) -> DbResult<()>;
            fn retrieve_merkle_tree_insertion_by_leaf_index(
                &self,
                leaf_index: &u32,
            ) -> DbResult<Option<MerkleTreeInsertion>>;
            fn store_merkle_leaf_index_by_message_id(
                &self,
                message_id: &H256,
                leaf_index: &u32,
            ) -> DbResult<()>;
            fn retrieve_merkle_leaf_index_by_message_id(&self, message_id: &H256) -> DbResult<Option<u32>>;
            fn store_merkle_tree_insertion_block_number_by_leaf_index(
                &self,
                leaf_index: &u32,
                block_number: &u64,
            ) -> DbResult<()>;
            fn retrieve_merkle_tree_insertion_block_number_by_leaf_index(
                &self,
                leaf_index: &u32,
            ) -> DbResult<Option<u64>>;
            fn store_highest_seen_message_nonce_number(&self, nonce: &u32) -> DbResult<()>;
            fn retrieve_highest_seen_message_nonce_number(&self) -> DbResult<Option<u32>>;

        }
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
            let backoff_duration = PendingMessage::calculate_msg_backoff(i, u32::MAX, None)
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
        format!("{}:{}:{}", hours, minutes, seconds)
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
}
