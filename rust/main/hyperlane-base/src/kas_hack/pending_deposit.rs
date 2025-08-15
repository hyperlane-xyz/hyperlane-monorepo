use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use async_trait::async_trait;
use dymension_kaspa::Deposit;
use hyperlane_core::{
    ChainResult, HyperlaneDomain, HyperlaneMessage, Mailbox, PendingOperation,
    PendingOperationResult, PendingOperationStatus, ReprepareReason, TryBatchAs, TxOutcome, H256,
    U256,
};
use prometheus::IntGauge;
use serde::Serialize;
use tracing::{debug, info};

use super::error::KaspaDepositError;

/// A pending Kaspa deposit operation that implements the PendingOperation trait
#[derive(Debug, Clone, Serialize)]
pub struct PendingKaspaDeposit {
    #[serde(skip)]
    pub deposit: Deposit,
    pub escrow_address: String,
    pub message_id: H256,
    pub destination_domain: HyperlaneDomain,

    status: PendingOperationStatus,
    num_retries: u32,
    next_attempt_after: Option<Instant>,
    metric: Option<Arc<IntGauge>>,
    submission_outcome: Option<TxOutcome>,
    sender: H256,
    recipient: H256,
}

impl PendingKaspaDeposit {
    pub fn new(
        deposit: Deposit,
        escrow_address: String,
        message_id: H256,
        destination_domain: HyperlaneDomain,
    ) -> Self {
        Self {
            deposit,
            escrow_address,
            message_id,
            destination_domain,
            status: PendingOperationStatus::FirstPrepareAttempt,
            num_retries: 0,
            next_attempt_after: None,
            metric: None,
            submission_outcome: None,
            sender: H256::default(),
            recipient: H256::default(),
        }
    }

    /// Process an error and determine the retry strategy
    pub fn handle_error(&mut self, err: &KaspaDepositError) -> PendingOperationResult {
        if !err.is_retryable() {
            info!(deposit_id = %self.deposit.id, error = %err, "Non-retryable error, dropping operation");
            return PendingOperationResult::Drop;
        }

        // Calculate retry delay
        let delay = if let Some(hint_secs) = err.retry_delay_hint() {
            Duration::from_secs_f64(hint_secs)
        } else {
            // Exponential backoff for general errors
            let base_delay = 30;
            let delay_secs = base_delay * (1 << self.num_retries.min(5));
            Duration::from_secs(delay_secs)
        };

        self.set_next_attempt_after(delay);

        debug!(
            deposit_id = %self.deposit.id,
            retry_count = self.num_retries,
            retry_after_secs = delay.as_secs(),
            "Scheduling retry"
        );

        PendingOperationResult::Reprepare(ReprepareReason::ErrorSubmitting)
    }
}

impl TryBatchAs<HyperlaneMessage> for PendingKaspaDeposit {}

#[async_trait]
#[typetag::serialize]
impl PendingOperation for PendingKaspaDeposit {
    fn id(&self) -> H256 {
        self.message_id
    }

    fn priority(&self) -> u32 {
        // Use deposit timestamp or sequence number if available
        // For now, use a default priority
        0
    }

    fn origin_domain_id(&self) -> u32 {
        // Kaspa domain ID - should be configured
        999999 // Placeholder
    }

    fn retrieve_status_from_db(&self) -> Option<PendingOperationStatus> {
        // TODO: Implement DB retrieval
        None
    }

    fn destination_domain(&self) -> &HyperlaneDomain {
        &self.destination_domain
    }

    fn sender_address(&self) -> &H256 {
        &self.sender
    }

    fn recipient_address(&self) -> &H256 {
        &self.recipient
    }

    fn body(&self) -> &[u8] {
        // Return deposit payload
        &[]
    }

    fn app_context(&self) -> Option<String> {
        Some("kaspa_deposit".to_string())
    }

    fn get_metric(&self) -> Option<Arc<IntGauge>> {
        self.metric.clone()
    }

    fn set_metric(&mut self, metric: Arc<IntGauge>) {
        self.metric = Some(metric);
    }

    fn status(&self) -> PendingOperationStatus {
        self.status.clone()
    }

    fn set_status(&mut self, status: PendingOperationStatus) {
        self.status = status;
    }

    async fn prepare(&mut self) -> PendingOperationResult {
        // Preparation logic would go here
        // For now, just mark as ready to submit
        PendingOperationResult::Success
    }

    async fn submit(&mut self) -> PendingOperationResult {
        // This would contain the actual submission logic
        // Currently a placeholder
        PendingOperationResult::Success
    }

    fn set_submission_outcome(&mut self, outcome: TxOutcome) {
        self.submission_outcome = Some(outcome);
    }

    fn get_tx_cost_estimate(&self) -> Option<U256> {
        // Estimate based on deposit size and current gas prices
        None
    }

    async fn confirm(&mut self) -> PendingOperationResult {
        // Confirmation logic
        PendingOperationResult::Success
    }

    async fn set_operation_outcome(
        &mut self,
        submission_outcome: TxOutcome,
        _submission_estimated_cost: U256,
    ) {
        self.submission_outcome = Some(submission_outcome);
    }

    fn next_attempt_after(&self) -> Option<Instant> {
        self.next_attempt_after
    }

    fn set_next_attempt_after(&mut self, delay: Duration) {
        self.next_attempt_after = Some(Instant::now() + delay);
        self.num_retries += 1;
    }

    fn reset_attempts(&mut self) {
        self.num_retries = 0;
        self.next_attempt_after = None;
    }

    fn set_retries(&mut self, retries: u32) {
        self.num_retries = retries;
    }

    fn get_retries(&self) -> u32 {
        self.num_retries
    }

    async fn payload(&self) -> ChainResult<Vec<u8>> {
        // Build the payload for submission
        Ok(vec![])
    }

    fn success_criteria(&self) -> ChainResult<Option<Vec<u8>>> {
        // Define success criteria
        Ok(None)
    }

    fn on_reprepare(
        &mut self,
        _err_msg: Option<String>,
        reason: ReprepareReason,
    ) -> PendingOperationResult {
        debug!(
            deposit_id = %self.deposit.id,
            reason = %reason,
            "Repreparing operation"
        );
        PendingOperationResult::Success
    }
}
