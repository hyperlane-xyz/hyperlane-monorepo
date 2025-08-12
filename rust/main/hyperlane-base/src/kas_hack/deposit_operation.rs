use dymension_kaspa::Deposit;
use std::time::{Duration, Instant};
use tracing::{debug, error, info};

#[derive(Debug, Clone)]
pub struct DepositOperation {
    pub deposit: Deposit,
    pub escrow_address: String,
    pub retry_count: u32,
    pub next_attempt_after: Option<Instant>,
    pub max_retries: u32,
}

impl DepositOperation {
    pub fn new(deposit: Deposit, escrow_address: String) -> Self {
        Self {
            deposit,
            escrow_address,
            retry_count: 0,
            next_attempt_after: None,
            max_retries: 3, // configurable max retries
        }
    }

    pub fn can_retry(&self) -> bool {
        self.retry_count < self.max_retries
    }

    pub fn is_ready(&self) -> bool {
        match self.next_attempt_after {
            Some(next_attempt) => Instant::now() >= next_attempt,
            None => true,
        }
    }

    pub fn mark_failed(&mut self) {
        self.retry_count += 1;
        if self.can_retry() {
            // Exponential backoff: 30s, 60s, 120s
            let delay_secs = 30 * (1 << (self.retry_count - 1).min(3));
            self.next_attempt_after = Some(Instant::now() + Duration::from_secs(delay_secs));
            info!(
                "Deposit operation failed, will retry in {}s (attempt {}/{}): {}",
                delay_secs,
                self.retry_count,
                self.max_retries,
                self.deposit.id
            );
        } else {
            error!(
                "Deposit operation failed permanently after {} attempts: {}",
                self.retry_count,
                self.deposit.id
            );
        }
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
        if let Some(pos) = self
            .operations
            .iter()
            .position(|op| op.is_ready() && op.can_retry())
        {
            self.operations.remove(pos)
        } else {
            None
        }
    }

    pub fn requeue(&mut self, operation: DepositOperation) {
        let operation_id = operation.deposit.id;
        if operation.can_retry() {
            self.operations.push_back(operation);
            debug!("Re-queued deposit operation: {}", operation_id);
        } else {
            error!(
                "Dropping deposit operation after max retries: {}",
                operation_id
            );
        }
    }

    pub fn len(&self) -> usize {
        self.operations.len()
    }

    pub fn is_empty(&self) -> bool {
        self.operations.is_empty()
    }

    /// Remove operations that have expired or exceeded max retries
    pub fn cleanup_expired(&mut self) {
        let initial_len = self.operations.len();
        self.operations.retain(|op| op.can_retry());
        let removed = initial_len - self.operations.len();
        if removed > 0 {
            debug!("Cleaned up {} expired/failed deposit operations", removed);
        }
    }
}