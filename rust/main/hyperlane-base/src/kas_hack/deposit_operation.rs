use dymension_kaspa::{conf::RelayerDepositTimings, Deposit};
use rand::Rng;
use std::cmp::Ordering;
use std::time::{Duration, Instant};
use tracing::error;

#[derive(Debug, Clone)]
pub struct DepositOperation {
    pub deposit: Deposit,
    pub escrow_address: String,
    pub retry_count: u32,
    pub next_attempt_after: Instant,
    pub created_at: Instant,
}

impl PartialEq for DepositOperation {
    fn eq(&self, other: &Self) -> bool {
        self.deposit.id == other.deposit.id
    }
}

impl Eq for DepositOperation {}

impl PartialOrd for DepositOperation {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for DepositOperation {
    fn cmp(&self, other: &Self) -> Ordering {
        match self
            .next_attempt_after
            .cmp(&other.next_attempt_after)
            .reverse()
        {
            Ordering::Equal => self.deposit.id.cmp(&other.deposit.id),
            other => other,
        }
    }
}

impl DepositOperation {
    pub fn new(deposit: Deposit, escrow_address: String) -> Self {
        let now = Instant::now();
        Self {
            deposit,
            escrow_address,
            retry_count: 0,
            next_attempt_after: now,
            created_at: now,
        }
    }

    pub fn is_ready(&self) -> bool {
        Instant::now() >= self.next_attempt_after
    }

    pub fn mark_failed(&mut self, cfg: &RelayerDepositTimings, custom_delay: Option<Duration>) {
        self.retry_count += 1;

        let delay = match custom_delay {
            Some(d) => d,
            None => {
                let base_delay = if self.retry_count == 1 {
                    cfg.retry_delay_base
                } else {
                    let base_secs = cfg.retry_delay_base.as_secs_f64();
                    let exponential_delay =
                        base_secs * cfg.retry_delay_exponent.powi((self.retry_count - 1) as i32);
                    let max_secs = cfg.retry_delay_max.as_secs_f64();
                    Duration::from_secs_f64(exponential_delay.min(max_secs))
                };

                // Add jitter: random multiplier between 0.75 and 1.25
                let mut rng = rand::thread_rng();
                let jitter = rng.gen_range(0.75..=1.25);
                let delay_secs = base_delay.as_secs_f64() * jitter;
                Duration::from_secs_f64(delay_secs)
            }
        };

        self.next_attempt_after = Instant::now() + delay;
        error!(
            deposit_id = %self.deposit.id,
            retry_count = self.retry_count,
            retry_after_secs = delay.as_secs_f64(),
            "Deposit operation failed"
        );
    }
}

#[derive(Debug)]
pub struct DepositTracker {
    seen: std::collections::HashSet<kaspa_consensus_core::tx::TransactionId>,
    pending: std::collections::BinaryHeap<DepositOperation>,
}

impl DepositTracker {
    pub fn new() -> Self {
        Self {
            seen: std::collections::HashSet::new(),
            pending: std::collections::BinaryHeap::new(),
        }
    }

    pub fn has_seen(&self, deposit: &Deposit) -> bool {
        self.seen.contains(&deposit.id)
    }

    pub fn track(&mut self, deposit: Deposit, escrow_address: String) -> bool {
        if self.seen.insert(deposit.id) {
            let op = DepositOperation::new(deposit, escrow_address);
            self.pending.push(op);
            true
        } else {
            false
        }
    }

    pub fn pop_ready(&mut self) -> Option<DepositOperation> {
        if let Some(op) = self.pending.peek() {
            if op.is_ready() {
                return self.pending.pop();
            }
        }
        None
    }

    pub fn requeue(&mut self, op: DepositOperation) {
        self.pending.push(op);
    }
}
