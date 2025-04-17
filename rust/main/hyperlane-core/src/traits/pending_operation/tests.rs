use std::cmp::Ord;
use std::env;

use super::*;

#[derive(Debug, Serialize)]
struct MockQueueOperation {
    id: H256,
    origin_domain_id: u32,
    priority: u32,
}

#[async_trait]
#[typetag::serialize]
impl PendingOperation for MockQueueOperation {
    fn id(&self) -> H256 {
        self.id
    }
    fn priority(&self) -> u32 {
        self.priority
    }
    fn origin_domain_id(&self) -> u32 {
        self.origin_domain_id
    }
    fn next_attempt_after(&self) -> Option<Instant> {
        None
    }
    fn retrieve_status_from_db(&self) -> Option<PendingOperationStatus> {
        None
    }
    fn destination_domain(&self) -> &HyperlaneDomain {
        unimplemented!()
    }
    fn sender_address(&self) -> &H256 {
        unimplemented!()
    }
    fn recipient_address(&self) -> &H256 {
        unimplemented!()
    }
    fn app_context(&self) -> Option<String> {
        None
    }
    fn get_metric(&self) -> Option<Arc<IntGauge>> {
        None
    }
    fn set_metric(&mut self, _metric: Arc<IntGauge>) {}
    fn status(&self) -> PendingOperationStatus {
        unimplemented!()
    }
    fn set_status(&mut self, _status: PendingOperationStatus) {}
    async fn prepare(&mut self) -> PendingOperationResult {
        unimplemented!()
    }
    async fn submit(&mut self) -> PendingOperationResult {
        unimplemented!()
    }
    fn set_submission_outcome(&mut self, _outcome: TxOutcome) {}
    fn get_tx_cost_estimate(&self) -> Option<U256> {
        None
    }
    async fn confirm(&mut self) -> PendingOperationResult {
        unimplemented!()
    }
    fn set_operation_outcome(
        &mut self,
        _submission_outcome: TxOutcome,
        _submission_estimated_cost: U256,
    ) {
    }
    fn set_next_attempt_after(&mut self, _delay: Duration) {}
    fn reset_attempts(&mut self) {}
    #[cfg(any(test, feature = "test-utils"))]
    fn set_retries(&mut self, _retries: u32) {}
    fn get_retries(&self) -> u32 {
        0
    }
    async fn payload(&self) -> ChainResult<Vec<u8>> {
        unimplemented!()
    }
    fn on_reprepare(
        &mut self,
        _err_msg: Option<String>,
        _reason: ReprepareReason,
    ) -> PendingOperationResult {
        unimplemented!()
    }
}

impl TryBatchAs<HyperlaneMessage> for MockQueueOperation {}

#[test]
fn test_encoding_pending_operation_status() {
    let status = PendingOperationStatus::Retry(ReprepareReason::CouldNotFetchMetadata);
    let encoded = status.to_vec();
    let decoded = PendingOperationStatus::read_from(&mut &encoded[..]).unwrap();
    assert_eq!(status, decoded);
}

#[test]
fn test_queue_operation_ord_without_mixing() {
    env::set_var("HYPERLANE_RELAYER_MIXING_ENABLED", "false");

    let op1 = Box::new(MockQueueOperation {
        id: H256::from_low_u64_be(1),
        origin_domain_id: 1,
        priority: 10,
    }) as QueueOperation;
    let op2 = Box::new(MockQueueOperation {
        id: H256::from_low_u64_be(2),
        origin_domain_id: 1,
        priority: 5,
    }) as QueueOperation;

    assert!(op1 > op2); // Higher priority value means lower priority
}

#[test]
fn test_queue_operation_ord_with_mixing() {
    env::set_var("HYPERLANE_RELAYER_MIXING_ENABLED", "true");
    env::set_var("HYPERLANE_RELAYER_MIXING_SALT", "123");

    let op1 = Box::new(MockQueueOperation {
        id: H256::from_low_u64_be(1),
        origin_domain_id: 1,
        priority: 10,
    }) as QueueOperation;
    let op2 = Box::new(MockQueueOperation {
        id: H256::from_low_u64_be(2),
        origin_domain_id: 1,
        priority: 5,
    }) as QueueOperation;

    // Calculate salted hashes for both operations
    let salt = env::var("HYPERLANE_RELAYER_MIXING_SALT")
        .map_or(0, |v| v.parse::<u32>().unwrap_or(0))
        .to_vec();
    let salted_hash_op1 = H256::from_slice(
        Keccak256::new()
            .chain(op1.id())
            .chain(&salt)
            .finalize()
            .as_slice(),
    );
    let salted_hash_op2 = H256::from_slice(
        Keccak256::new()
            .chain(op2.id())
            .chain(&salt)
            .finalize()
            .as_slice(),
    );

    // Assert that the ordering matches the salted hash comparison
    assert_eq!(op1.cmp(&op2), salted_hash_op1.cmp(&salted_hash_op2));
}
