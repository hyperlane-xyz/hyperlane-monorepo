use hyperlane_core::{
    HyperlaneDomain, HyperlaneDomainProtocol, HyperlaneDomainTechnicalStack, HyperlaneDomainType,
    HyperlaneMessage, PendingOperation, PendingOperationResult, PendingOperationStatus, TryBatchAs,
    TxOutcome, H256, U256,
};
use prometheus::IntGauge;
use serde::Serialize;
use std::{
    str::FromStr,
    sync::Arc,
    time::{Duration, Instant},
};

#[derive(Debug, Clone, Serialize)]
pub struct MockPendingOperation {
    id: H256,
    sender_address: H256,
    origin_domain_id: u32,
    destination_domain_id: u32,
    recipient_address: H256,
    seconds_to_next_attempt: u64,
    destination_domain: HyperlaneDomain,
}

impl MockPendingOperation {
    pub fn new(seconds_to_next_attempt: u64, destination_domain: HyperlaneDomain) -> Self {
        Self {
            id: H256::random(),
            seconds_to_next_attempt,
            destination_domain_id: destination_domain.id(),
            destination_domain,
            sender_address: H256::random(),
            recipient_address: H256::random(),
            origin_domain_id: 0,
        }
    }

    pub fn with_message_data(message: HyperlaneMessage) -> Self {
        Self {
            id: message.id(),
            sender_address: message.sender,
            recipient_address: message.recipient,
            origin_domain_id: message.origin,
            destination_domain_id: message.destination,
            seconds_to_next_attempt: 0,
            destination_domain: HyperlaneDomain::Unknown {
                domain_id: message.destination,
                domain_name: "test".to_string(),
                domain_type: HyperlaneDomainType::Unknown,
                domain_protocol: HyperlaneDomainProtocol::Ethereum,
                domain_technical_stack: HyperlaneDomainTechnicalStack::Other,
            },
        }
    }

    pub fn with_id(self, id: &str) -> Self {
        Self {
            id: H256::from_str(id).unwrap(),
            ..self
        }
    }

    pub fn with_sender_address(self, sender_address: &str) -> Self {
        Self {
            sender_address: H256::from_str(sender_address).unwrap(),
            ..self
        }
    }

    pub fn with_recipient_address(self, recipient_address: &str) -> Self {
        Self {
            recipient_address: H256::from_str(recipient_address).unwrap(),
            ..self
        }
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap()
    }
}

impl TryBatchAs<HyperlaneMessage> for MockPendingOperation {}

#[async_trait::async_trait]
#[typetag::serialize]
impl PendingOperation for MockPendingOperation {
    fn id(&self) -> H256 {
        self.id
    }

    fn status(&self) -> PendingOperationStatus {
        PendingOperationStatus::FirstPrepareAttempt
    }

    fn set_status(&mut self, _status: PendingOperationStatus) {}

    fn reset_attempts(&mut self) {
        self.seconds_to_next_attempt = 0;
    }

    fn sender_address(&self) -> &H256 {
        &self.sender_address
    }

    fn recipient_address(&self) -> &H256 {
        &self.recipient_address
    }

    fn get_metric(&self) -> Option<Arc<IntGauge>> {
        None
    }

    fn set_metric(&mut self, _metric: Arc<IntGauge>) {}

    fn priority(&self) -> u32 {
        todo!()
    }

    fn retrieve_status_from_db(&self) -> Option<PendingOperationStatus> {
        todo!()
    }

    fn get_operation_labels(&self) -> (String, String) {
        Default::default()
    }

    fn origin_domain_id(&self) -> u32 {
        self.origin_domain_id
    }

    fn destination_domain(&self) -> &HyperlaneDomain {
        &self.destination_domain
    }

    fn app_context(&self) -> Option<String> {
        todo!()
    }

    async fn prepare(&mut self) -> PendingOperationResult {
        todo!()
    }

    /// Submit this operation to the blockchain and report if it was successful
    /// or not.
    async fn submit(&mut self) -> PendingOperationResult {
        todo!()
    }

    fn set_submission_outcome(&mut self, _outcome: TxOutcome) {
        todo!()
    }

    fn get_tx_cost_estimate(&self) -> Option<U256> {
        todo!()
    }

    /// This will be called after the operation has been submitted and is
    /// responsible for checking if the operation has reached a point at
    /// which we consider it safe from reorgs.
    async fn confirm(&mut self) -> PendingOperationResult {
        todo!()
    }

    fn set_operation_outcome(
        &mut self,
        _submission_outcome: TxOutcome,
        _submission_estimated_cost: U256,
    ) {
        todo!()
    }

    fn next_attempt_after(&self) -> Option<Instant> {
        Some(
            Instant::now()
                .checked_add(Duration::from_secs(self.seconds_to_next_attempt))
                .unwrap(),
        )
    }

    fn set_next_attempt_after(&mut self, _delay: Duration) {
        todo!()
    }

    fn set_retries(&mut self, _retries: u32) {
        todo!()
    }
}
