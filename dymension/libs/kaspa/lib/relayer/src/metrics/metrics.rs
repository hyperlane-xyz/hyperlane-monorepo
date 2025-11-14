use prometheus::{GaugeVec, Histogram, HistogramOpts, IntCounter, IntGauge, Opts, Registry};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::Instant;

/// Singleton storage for KaspaBridgeMetrics instances per registry
static KASPA_METRICS_INSTANCES: OnceLock<Mutex<HashMap<usize, Arc<KaspaBridgeMetrics>>>> =
    OnceLock::new();

/// Kaspa relayer-specific metrics following Prometheus best practices
#[derive(Debug, Clone)]
pub struct KaspaBridgeMetrics {
    // Balance gauges
    /// Current balance of the relayer address in sompi
    pub relayer_address_funds: IntGauge,

    /// Total funds currently held in escrow in sompi
    pub funds_escrowed: IntGauge,

    /// Number of UTXOs in escrow address
    pub escrow_utxo_count: IntGauge,

    // Deposit metrics
    /// Distribution of deposit amounts in sompi
    pub deposit_amount_sompi: Histogram,

    /// Distribution of deposit processing latency in seconds (from detection to Hub confirmation)
    pub deposit_duration_seconds: Histogram,

    /// Cumulative amount of deposits processed in sompi
    pub total_funds_deposited: IntCounter,

    /// Total number of deposits successfully processed
    pub deposits_processed_total: IntCounter,

    // Withdrawal metrics
    /// Distribution of withdrawal amounts in sompi
    pub withdrawal_amount_sompi: Histogram,

    /// Distribution of withdrawal processing latency in seconds (from reception to Kaspa TX success)
    pub withdrawal_duration_seconds: Histogram,

    /// Distribution of messages per withdrawal batch
    pub withdrawal_batch_messages: Histogram,

    /// Cumulative amount of withdrawals processed in sompi
    pub total_funds_withdrawn: IntCounter,

    /// Total number of withdrawal messages successfully processed
    pub withdrawals_processed_total: IntCounter,

    // Failure tracking
    /// Number of unique withdrawals currently in failed state
    pub pending_failed_withdrawals: IntGauge,

    /// Number of unique deposits currently in failed state
    pub pending_failed_deposits: IntGauge,

    /// Total amount in sompi currently in failed withdrawal state
    pub failed_withdrawal_funds_sompi: IntGauge,

    /// Total amount in sompi currently in failed deposit state
    pub failed_deposit_funds_sompi: IntGauge,

    // Confirmation metrics
    /// Total number of confirmation failures
    pub confirmations_failed: IntCounter,

    /// Number of confirmations currently pending
    pub confirmations_pending: IntGauge,

    // Anchor point info
    /// Hub anchor point information (info metric with transaction ID as label)
    pub hub_anchor_point_info: GaugeVec,

    /// Last withdrawal anchor point information (info metric tracking last confirmed withdrawal)
    pub last_anchor_point_info: GaugeVec,

    // Internal tracking state (not exposed as metrics)
    /// Track unique failed deposits to avoid double counting
    failed_deposit_ids: Arc<RwLock<HashSet<String>>>,

    /// Track amounts of failed deposits
    failed_deposit_amounts: Arc<RwLock<HashMap<String, u64>>>,

    /// Track unique failed withdrawals to avoid double counting
    failed_withdrawal_ids: Arc<RwLock<HashSet<String>>>,

    /// Track amounts of failed withdrawals
    failed_withdrawal_amounts: Arc<RwLock<HashMap<String, u64>>>,

    /// Track withdrawal start times for latency calculation (keyed by message ID)
    withdrawal_start_times: Arc<RwLock<HashMap<String, Instant>>>,
}

impl KaspaBridgeMetrics {
    pub fn new(registry: &Registry) -> prometheus::Result<Self> {
        let registry_id = registry as *const Registry as usize;

        // Check if we already have an instance for this registry
        let instances_map = KASPA_METRICS_INSTANCES.get_or_init(|| Mutex::new(HashMap::new()));
        let mut instances = instances_map.lock().unwrap();

        if let Some(existing_instance) = instances.get(&registry_id) {
            return Ok((**existing_instance).clone());
        }

        // Create Kaspa relayer metrics using the provided registry
        let relayer_address_funds = IntGauge::new(
            "kaspa_relayer_address_funds_sompi",
            "Current balance of the relayer address in sompi",
        )?;
        // Register the metric - if already exists, just continue
        let _ = registry.register(Box::new(relayer_address_funds.clone()));

        let funds_escrowed = IntGauge::new(
            "kaspa_funds_escrowed_sompi",
            "Total funds currently held in escrow in sompi",
        )?;
        let _ = registry.register(Box::new(funds_escrowed.clone()));

        let total_funds_deposited = IntCounter::new(
            "kaspa_total_funds_deposited_sompi",
            "Cumulative amount of deposits processed in sompi",
        )?;
        let _ = registry.register(Box::new(total_funds_deposited.clone()));

        let total_funds_withdrawn = IntCounter::new(
            "kaspa_total_funds_withdrawn_sompi",
            "Cumulative amount of withdrawals processed in sompi",
        )?;
        let _ = registry.register(Box::new(total_funds_withdrawn.clone()));

        let pending_failed_withdrawals = IntGauge::new(
            "kaspa_pending_failed_withdrawals",
            "Number of unique withdrawals currently in failed state",
        )?;
        let _ = registry.register(Box::new(pending_failed_withdrawals.clone()));

        let pending_failed_deposits = IntGauge::new(
            "kaspa_pending_failed_deposits",
            "Number of unique deposits currently in failed state",
        )?;
        let _ = registry.register(Box::new(pending_failed_deposits.clone()));

        let failed_withdrawal_funds_sompi = IntGauge::new(
            "kaspa_failed_withdrawal_funds_sompi",
            "Total amount in sompi currently in failed withdrawal state",
        )?;
        let _ = registry.register(Box::new(failed_withdrawal_funds_sompi.clone()));

        let failed_deposit_funds_sompi = IntGauge::new(
            "kaspa_failed_deposit_funds_sompi",
            "Total amount in sompi currently in failed deposit state",
        )?;
        let _ = registry.register(Box::new(failed_deposit_funds_sompi.clone()));

        let confirmations_failed = IntCounter::new(
            "kaspa_confirmations_failed_total",
            "Total number of confirmation failures",
        )?;
        let _ = registry.register(Box::new(confirmations_failed.clone()));

        let confirmations_pending = IntGauge::new(
            "kaspa_confirmations_pending",
            "Number of confirmations currently pending",
        )?;
        let _ = registry.register(Box::new(confirmations_pending.clone()));

        let escrow_utxo_count = IntGauge::new(
            "kaspa_escrow_utxo_count",
            "Number of UTXOs in escrow address",
        )?;
        let _ = registry.register(Box::new(escrow_utxo_count.clone()));

        let deposits_processed_total = IntCounter::new(
            "kaspa_deposits_processed_total",
            "Total number of deposits successfully processed",
        )?;
        let _ = registry.register(Box::new(deposits_processed_total.clone()));

        let withdrawals_processed_total = IntCounter::new(
            "kaspa_withdrawals_processed_total",
            "Total number of withdrawal messages successfully processed",
        )?;
        let _ = registry.register(Box::new(withdrawals_processed_total.clone()));

        // Histogram for deposit amounts: 0.1 KAS, 1 KAS, 10 KAS, 100 KAS, 1000 KAS, 10k KAS, 100k KAS, 1M KAS
        let deposit_amount_sompi = Histogram::with_opts(
            HistogramOpts::new(
                "kaspa_deposit_amount_sompi",
                "Distribution of deposit amounts in sompi",
            )
            .buckets(vec![
                10_000_000.0,
                100_000_000.0,
                1_000_000_000.0,
                10_000_000_000.0,
                100_000_000_000.0,
                1_000_000_000_000.0,
                10_000_000_000_000.0,
                100_000_000_000_000.0,
            ]),
        )?;
        let _ = registry.register(Box::new(deposit_amount_sompi.clone()));

        // Histogram for deposit durations: 10s, 30s, 1m, 2m, 5m, 10m, 30m, 1h, 2h, 6h, 12h, 24h
        let deposit_duration_seconds = Histogram::with_opts(
            HistogramOpts::new(
                "kaspa_deposit_duration_seconds",
                "Distribution of deposit processing latency in seconds",
            )
            .buckets(vec![
                10.0, 30.0, 60.0, 120.0, 300.0, 600.0, 1800.0, 3600.0, 7200.0, 21600.0, 43200.0,
                86400.0,
            ]),
        )?;
        let _ = registry.register(Box::new(deposit_duration_seconds.clone()));

        // Histogram for withdrawal amounts: 0.1 KAS, 1 KAS, 10 KAS, 100 KAS, 1000 KAS, 10k KAS, 100k KAS, 1M KAS
        let withdrawal_amount_sompi = Histogram::with_opts(
            HistogramOpts::new(
                "kaspa_withdrawal_amount_sompi",
                "Distribution of withdrawal amounts in sompi",
            )
            .buckets(vec![
                10_000_000.0,
                100_000_000.0,
                1_000_000_000.0,
                10_000_000_000.0,
                100_000_000_000.0,
                1_000_000_000_000.0,
                10_000_000_000_000.0,
                100_000_000_000_000.0,
            ]),
        )?;
        let _ = registry.register(Box::new(withdrawal_amount_sompi.clone()));

        // Histogram for withdrawal durations: 10s, 30s, 1m, 2m, 5m, 10m, 30m, 1h, 2h, 6h, 12h, 24h
        let withdrawal_duration_seconds = Histogram::with_opts(
            HistogramOpts::new(
                "kaspa_withdrawal_duration_seconds",
                "Distribution of withdrawal processing latency in seconds",
            )
            .buckets(vec![
                10.0, 30.0, 60.0, 120.0, 300.0, 600.0, 1800.0, 3600.0, 7200.0, 21600.0, 43200.0,
                86400.0,
            ]),
        )?;
        let _ = registry.register(Box::new(withdrawal_duration_seconds.clone()));

        // Histogram for withdrawal batch message counts: 1, 2, 5, 10, 20, 50, 100
        let withdrawal_batch_messages = Histogram::with_opts(
            HistogramOpts::new(
                "kaspa_withdrawal_batch_messages",
                "Distribution of messages per withdrawal batch",
            )
            .buckets(vec![1.0, 2.0, 5.0, 10.0, 20.0, 50.0, 100.0]),
        )?;
        let _ = registry.register(Box::new(withdrawal_batch_messages.clone()));

        let hub_anchor_point_info = GaugeVec::new(
            Opts::new(
                "kaspa_hub_anchor_point_info",
                "Current hub anchor point transaction ID and metadata",
            ),
            &["tx_id", "outpoint_index", "updated_at"],
        )?;
        let _ = registry.register(Box::new(hub_anchor_point_info.clone()));

        let last_anchor_point_info = GaugeVec::new(
            Opts::new(
                "kaspa_last_anchor_point_info",
                "Last withdrawal anchor point transaction ID and metadata",
            ),
            &["tx_id", "outpoint_index", "updated_at"],
        )?;
        let _ = registry.register(Box::new(last_anchor_point_info.clone()));

        let new_instance = Self {
            // Balances
            relayer_address_funds,
            funds_escrowed,
            escrow_utxo_count,
            // Deposits
            deposit_amount_sompi,
            deposit_duration_seconds,
            total_funds_deposited,
            deposits_processed_total,
            // Withdrawals
            withdrawal_amount_sompi,
            withdrawal_duration_seconds,
            withdrawal_batch_messages,
            total_funds_withdrawn,
            withdrawals_processed_total,
            // Failures
            pending_failed_withdrawals,
            pending_failed_deposits,
            failed_withdrawal_funds_sompi,
            failed_deposit_funds_sompi,
            // Confirmations
            confirmations_failed,
            confirmations_pending,
            // Anchor points
            hub_anchor_point_info,
            last_anchor_point_info,
            // Internal tracking
            failed_deposit_ids: Arc::new(RwLock::new(HashSet::new())),
            failed_deposit_amounts: Arc::new(RwLock::new(HashMap::new())),
            failed_withdrawal_ids: Arc::new(RwLock::new(HashSet::new())),
            failed_withdrawal_amounts: Arc::new(RwLock::new(HashMap::new())),
            withdrawal_start_times: Arc::new(RwLock::new(HashMap::new())),
        };

        // Store the instance in our singleton map
        let instance_arc = Arc::new(new_instance.clone());
        instances.insert(registry_id, instance_arc);

        Ok(new_instance)
    }

    /// Update relayer address balance
    pub fn update_relayer_funds(&self, balance_sompi: i64) {
        self.relayer_address_funds.set(balance_sompi);
    }

    /// Update escrow balance
    pub fn update_funds_escrowed(&self, balance_sompi: i64) {
        self.funds_escrowed.set(balance_sompi);
    }

    /// Record successful deposit processing with amount, ID, and timing from creation
    pub fn record_deposit_processed(
        &self,
        deposit_id: &str,
        amount_sompi: u64,
        created_at: std::time::Instant,
    ) {
        // Calculate and observe duration
        let duration_secs = created_at.elapsed().as_secs_f64();
        self.deposit_duration_seconds.observe(duration_secs);

        // Observe amount
        self.deposit_amount_sompi.observe(amount_sompi as f64);

        // Update counters
        self.total_funds_deposited.inc_by(amount_sompi);
        self.deposits_processed_total.inc();

        // Remove from failed set if it was previously failed and decrement pending count and amount
        let mut failed_ids = self.failed_deposit_ids.write().unwrap();
        let mut failed_amounts = self.failed_deposit_amounts.write().unwrap();
        if failed_ids.remove(deposit_id) {
            self.pending_failed_deposits.dec();
            if let Some(failed_amount) = failed_amounts.remove(deposit_id) {
                self.failed_deposit_funds_sompi.sub(failed_amount as i64);
            }
        }
    }

    /// Record withdrawal message initiation - stores start time for the message
    pub fn record_withdrawal_initiated(&self, message_id: &str, amount_sompi: u64) {
        // Store start time for this message
        let mut start_times = self.withdrawal_start_times.write().unwrap();
        start_times.insert(message_id.to_string(), Instant::now());

        // Observe amount
        self.withdrawal_amount_sompi.observe(amount_sompi as f64);
    }

    /// Record withdrawal batch size
    pub fn record_withdrawal_batch_size(&self, message_count: u64) {
        self.withdrawal_batch_messages.observe(message_count as f64);
    }

    /// Record successful withdrawal processing - calculates duration and updates counters
    pub fn record_withdrawal_processed(&self, message_id: &str, amount_sompi: u64) {
        // Calculate and observe duration if we have a start time
        let mut start_times = self.withdrawal_start_times.write().unwrap();
        if let Some(start_time) = start_times.remove(message_id) {
            let duration_secs = start_time.elapsed().as_secs_f64();
            self.withdrawal_duration_seconds.observe(duration_secs);
        } else {
            tracing::warn!(
                message_id = %message_id,
                "Withdrawal message completed but no start time found - latency metric will not be recorded"
            );
        }
        drop(start_times);

        // Update counters
        self.total_funds_withdrawn.inc_by(amount_sompi);
        self.withdrawals_processed_total.inc();

        // Remove from failed set if it was previously failed
        let mut failed_ids = self.failed_withdrawal_ids.write().unwrap();
        let mut failed_amounts = self.failed_withdrawal_amounts.write().unwrap();
        if failed_ids.remove(message_id) {
            self.pending_failed_withdrawals.dec();
            if let Some(failed_amount) = failed_amounts.remove(message_id) {
                self.failed_withdrawal_funds_sompi.sub(failed_amount as i64);
            }
        }
    }

    /// Record failed deposit attempt with deduplication
    /// Returns true if this is a new failure, false if it's a retry of an already-failed deposit
    pub fn record_deposit_failed(&self, deposit_id: &str, amount_sompi: u64) -> bool {
        let mut failed_ids = self.failed_deposit_ids.write().unwrap();
        let mut failed_amounts = self.failed_deposit_amounts.write().unwrap();

        // Check if this deposit has already failed before
        if failed_ids.insert(deposit_id.to_string()) {
            // This is a new failure, increment pending failed deposits count and track amount
            self.pending_failed_deposits.inc();
            failed_amounts.insert(deposit_id.to_string(), amount_sompi);
            self.failed_deposit_funds_sompi.add(amount_sompi as i64);
            true
        } else {
            // This deposit has already been counted as failed, no change to pending count
            false
        }
    }

    /// Record failed withdrawal attempt with deduplication
    /// Returns true if this is a new failure, false if it's a retry of an already-failed withdrawal
    pub fn record_withdrawal_failed(&self, message_id: &str, amount_sompi: u64) -> bool {
        let mut failed_ids = self.failed_withdrawal_ids.write().unwrap();
        let mut failed_amounts = self.failed_withdrawal_amounts.write().unwrap();

        // Check if this message has already failed before
        if failed_ids.insert(message_id.to_string()) {
            // This is a new failure for this message
            self.pending_failed_withdrawals.inc();
            failed_amounts.insert(message_id.to_string(), amount_sompi);
            self.failed_withdrawal_funds_sompi.add(amount_sompi as i64);
            true
        } else {
            // This withdrawal has already been counted as failed, no change to pending count
            false
        }
    }

    /// Record confirmation failure
    pub fn record_confirmation_failed(&self) {
        self.confirmations_failed.inc();
    }

    /// Update pending confirmations count
    pub fn update_confirmations_pending(&self, count: i64) {
        self.confirmations_pending.set(count);
    }

    /// Update the number of UTXOs in escrow address
    pub fn update_escrow_utxo_count(&self, count: i64) {
        self.escrow_utxo_count.set(count);
    }

    /// Update hub anchor point information
    pub fn update_hub_anchor_point(&self, tx_id: &str, outpoint_index: u64, timestamp: u64) {
        // Reset all existing values first
        self.hub_anchor_point_info.reset();

        // Set new anchor point info
        self.hub_anchor_point_info
            .with_label_values(&[tx_id, &outpoint_index.to_string(), &timestamp.to_string()])
            .set(1.0);
    }

    /// Update last withdrawal anchor point information
    pub fn update_last_anchor_point(&self, tx_id: &str, outpoint_index: u64, timestamp: u64) {
        // Reset all existing values first
        self.last_anchor_point_info.reset();

        // Set new last anchor point info
        self.last_anchor_point_info
            .with_label_values(&[tx_id, &outpoint_index.to_string(), &timestamp.to_string()])
            .set(1.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_metrics_creation() {
        let registry = Registry::new();
        let metrics = KaspaBridgeMetrics::new(&registry).expect("Failed to create metrics");

        // Test initial values for gauges
        assert_eq!(metrics.relayer_address_funds.get(), 0);
        assert_eq!(metrics.funds_escrowed.get(), 0);
        assert_eq!(metrics.pending_failed_withdrawals.get(), 0);
        assert_eq!(metrics.pending_failed_deposits.get(), 0);
        assert_eq!(metrics.failed_withdrawal_funds_sompi.get(), 0);
        assert_eq!(metrics.failed_deposit_funds_sompi.get(), 0);
        assert_eq!(metrics.confirmations_pending.get(), 0);
        assert_eq!(metrics.escrow_utxo_count.get(), 0);

        // Test initial values for counters
        assert_eq!(metrics.deposits_processed_total.get(), 0);
        assert_eq!(metrics.withdrawals_processed_total.get(), 0);
        assert_eq!(metrics.total_funds_deposited.get(), 0);
        assert_eq!(metrics.total_funds_withdrawn.get(), 0);

        // Histograms start with no observations, which we can verify by checking sample count
        assert_eq!(metrics.deposit_amount_sompi.get_sample_count(), 0);
        assert_eq!(metrics.deposit_duration_seconds.get_sample_count(), 0);
        assert_eq!(metrics.withdrawal_amount_sompi.get_sample_count(), 0);
        assert_eq!(metrics.withdrawal_duration_seconds.get_sample_count(), 0);
        assert_eq!(metrics.withdrawal_batch_messages.get_sample_count(), 0);
    }

    #[test]
    fn test_metrics_operations() {
        let registry = Registry::new();
        let metrics = KaspaBridgeMetrics::new(&registry).expect("Failed to create metrics");

        // Test balance updates
        metrics.update_relayer_funds(1000000);
        assert_eq!(metrics.relayer_address_funds.get(), 1000000);

        metrics.update_funds_escrowed(500000);
        assert_eq!(metrics.funds_escrowed.get(), 500000);

        // Test deposit processing with timing
        let deposit_start = Instant::now();
        std::thread::sleep(std::time::Duration::from_millis(10)); // Small delay to ensure measurable duration

        let initial_total = metrics.total_funds_deposited.get();
        let initial_count = metrics.deposits_processed_total.get();
        metrics.record_deposit_processed("deposit_1", 100000, deposit_start);

        assert_eq!(
            metrics.total_funds_deposited.get() as u64,
            initial_total as u64 + 100000
        );
        assert_eq!(metrics.deposits_processed_total.get(), initial_count + 1);
        assert_eq!(metrics.deposit_amount_sompi.get_sample_count(), 1);
        assert_eq!(metrics.deposit_duration_seconds.get_sample_count(), 1);

        // Test withdrawal processing with timing
        metrics.record_withdrawal_initiated("msg_1", 50000);
        metrics.record_withdrawal_batch_size(1);
        std::thread::sleep(std::time::Duration::from_millis(10)); // Small delay

        let initial_total = metrics.total_funds_withdrawn.get();
        let initial_count = metrics.withdrawals_processed_total.get();
        metrics.record_withdrawal_processed("msg_1", 50000);

        assert_eq!(
            metrics.total_funds_withdrawn.get() as u64,
            initial_total as u64 + 50000
        );
        assert_eq!(metrics.withdrawals_processed_total.get(), initial_count + 1);
        assert_eq!(metrics.withdrawal_amount_sompi.get_sample_count(), 1);
        assert_eq!(metrics.withdrawal_duration_seconds.get_sample_count(), 1);
        assert_eq!(metrics.withdrawal_batch_messages.get_sample_count(), 1);

        // Test failure tracking
        let is_new_failure = metrics.record_deposit_failed("deposit_2", 20000);
        assert!(is_new_failure);
        assert_eq!(metrics.pending_failed_deposits.get(), 1);
        assert_eq!(metrics.failed_deposit_funds_sompi.get(), 20000);

        // Test duplicate failure tracking (retry of same deposit)
        let is_new_failure = metrics.record_deposit_failed("deposit_2", 20000);
        assert!(!is_new_failure);
        assert_eq!(metrics.pending_failed_deposits.get(), 1);
        assert_eq!(metrics.failed_deposit_funds_sompi.get(), 20000);

        let is_new_failure = metrics.record_withdrawal_failed("msg_2", 30000);
        assert!(is_new_failure);
        assert_eq!(metrics.pending_failed_withdrawals.get(), 1);
        assert_eq!(metrics.failed_withdrawal_funds_sompi.get(), 30000);

        // Test failure removal on success
        let deposit2_start = Instant::now();
        metrics.record_deposit_processed("deposit_2", 10000, deposit2_start);
        assert_eq!(metrics.pending_failed_deposits.get(), 0);
        assert_eq!(metrics.failed_deposit_funds_sompi.get(), 0);

        metrics.record_withdrawal_initiated("msg_3", 5000);
        metrics.record_withdrawal_processed("msg_3", 5000);

        // Test confirmation metrics
        metrics.record_confirmation_failed();
        assert_eq!(metrics.confirmations_failed.get() as u64, 1);

        metrics.update_confirmations_pending(5);
        assert_eq!(metrics.confirmations_pending.get(), 5);

        // Test UTXO count
        metrics.update_escrow_utxo_count(10);
        assert_eq!(metrics.escrow_utxo_count.get(), 10);

        // Test histogram observations for withdrawal batches
        metrics.record_withdrawal_batch_size(5);
        metrics.record_withdrawal_initiated("batch_1_msg", 1000000);

        metrics.record_withdrawal_batch_size(10);
        metrics.record_withdrawal_initiated("batch_2_msg1", 1000000);
        metrics.record_withdrawal_initiated("batch_2_msg2", 1000000);

        metrics.record_withdrawal_batch_size(2);
        metrics.record_withdrawal_initiated("batch_3_msg", 500000);

        // Verify we have 3 more batch observations (plus the 1 from earlier test)
        assert_eq!(metrics.withdrawal_batch_messages.get_sample_count(), 4);
    }

    #[test]
    fn test_duplicate_metrics_creation() {
        let registry = Registry::new();
        // Create first instance - should work fine
        let metrics1 =
            KaspaBridgeMetrics::new(&registry).expect("Failed to create first metrics instance");

        // Create second instance - should handle duplicate registration gracefully
        let metrics2 =
            KaspaBridgeMetrics::new(&registry).expect("Failed to create second metrics instance");

        // Test that both metrics instances are functional
        metrics1.update_relayer_funds(1000000);
        metrics2.update_funds_escrowed(500000);

        // Verify the values are accessible (they share the same underlying metrics)
        assert_eq!(metrics1.relayer_address_funds.get(), 1000000);
        assert_eq!(metrics2.funds_escrowed.get(), 500000);
    }
}
