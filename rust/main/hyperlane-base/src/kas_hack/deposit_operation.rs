use dymension_kaspa::{conf::KaspaTimeConfig, Deposit};
use std::time::{Duration, Instant};
use tracing::{debug, info};

#[derive(Debug, Clone)]
pub struct DepositOperation {
    pub deposit: Deposit,
    pub escrow_address: String,
    pub retry_count: u32,
    pub next_attempt_after: Option<Instant>,
    /// When this deposit operation was first created/detected
    pub created_at: Instant,
}

impl DepositOperation {
    pub fn new(deposit: Deposit, escrow_address: String) -> Self {
        Self {
            deposit,
            escrow_address,
            retry_count: 0,
            next_attempt_after: None,
            created_at: Instant::now(),
        }
    }

    pub fn is_ready(&self) -> bool {
        match self.next_attempt_after {
            Some(next_attempt) => Instant::now() >= next_attempt,
            None => true,
        }
    }

    pub fn mark_failed(&mut self, config: &KaspaTimeConfig) {
        self.retry_count += 1;
        // Exponential backoff with configurable base
        let delay_secs = config.base_retry_delay_secs * (1 << (self.retry_count - 1).min(5));
        self.next_attempt_after = Some(Instant::now() + Duration::from_secs(delay_secs));
        info!(
            deposit_id = %self.deposit.id,
            retry_count = self.retry_count,
            retry_after_secs = delay_secs,
            "Deposit operation failed, scheduling retry"
        );
    }

    /// Mark failed with custom retry timing (for finality-based delays)
    pub fn mark_failed_with_custom_delay(&mut self, delay: Duration, reason: &str) {
        self.retry_count += 1;
        self.next_attempt_after = Some(Instant::now() + delay);
        info!(
            deposit_id = %self.deposit.id,
            retry_count = self.retry_count,
            retry_after_secs = delay.as_secs_f64(),
            reason = %reason,
            "Deposit operation failed with custom delay"
        );
    }

    pub fn reset_attempts(&mut self) {
        self.retry_count = 0;
        self.next_attempt_after = None;
    }
}

/// Simple operation queue for managing deposit retries
#[derive(Debug)]
pub struct DepositOpQueue {
    operations: std::collections::VecDeque<DepositOperation>,
}

impl DepositOpQueue {
    pub fn new() -> Self {
        Self {
            operations: std::collections::VecDeque::new(),
        }
    }

    pub fn push(&mut self, operation: DepositOperation) {
        let operation_id = operation.deposit.id;
        self.operations.push_back(operation);
        debug!("Added deposit operation to queue: {}", operation_id);
    }

    pub fn pop_ready(&mut self) -> Option<DepositOperation> {
        if let Some(pos) = self.operations.iter().position(|op| op.is_ready()) {
            self.operations.remove(pos)
        } else {
            None
        }
    }

    pub fn requeue(&mut self, operation: DepositOperation) {
        let operation_id = operation.deposit.id;
        self.operations.push_back(operation);
        debug!("Re-queued deposit operation: {}", operation_id);
    }

    pub fn len(&self) -> usize {
        self.operations.len()
    }

    pub fn is_empty(&self) -> bool {
        self.operations.is_empty()
    }
}
