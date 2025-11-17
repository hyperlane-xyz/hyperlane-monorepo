use prometheus::{GaugeVec, IntCounter, IntGauge, Opts, Registry};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock, RwLock};

/// Singleton storage for KaspaBridgeMetrics instances per registry
static KASPA_METRICS_INSTANCES: OnceLock<Mutex<HashMap<usize, Arc<KaspaBridgeMetrics>>>> =
    OnceLock::new();

/// Kaspa relayer-specific metrics matching the requested specification
#[derive(Debug, Clone)]
pub struct KaspaBridgeMetrics {
    /// Relayer address funds - Current balance of the relayer address in sompi
    pub relayer_address_funds: IntGauge,

    /// Funds escrowed - Total funds currently held in escrow in sompi
    pub funds_escrowed: IntGauge,

    /// Total funds deposited - Cumulative amount of deposits processed in sompi
    pub total_funds_deposited: IntCounter,

    /// Total funds withdrawn - Cumulative amount of withdrawals processed in sompi
    pub total_funds_withdrawn: IntCounter,

    /// Pending failed withdrawals - Number of unique withdrawals currently in failed state
    pub pending_failed_withdrawals: IntGauge,

    /// Pending failed deposits - Number of unique deposits currently in failed state
    pub pending_failed_deposits: IntGauge,

    /// Failed withdrawal funds - Total amount in sompi currently in failed withdrawal state
    pub failed_withdrawal_funds_sompi: IntGauge,

    /// Failed deposit funds - Total amount in sompi currently in failed deposit state  
    pub failed_deposit_funds_sompi: IntGauge,

    /// Confirmations failed - Total number of confirmation failures
    pub confirmations_failed: IntCounter,

    /// Confirmations pending - Number of confirmations currently pending
    pub confirmations_pending: IntGauge,

    /// Number of UTXOs in escrow address
    pub escrow_utxo_count: IntGauge,

    /// Total number of deposits successfully processed
    pub deposits_processed_total: IntCounter,

    /// Total number of withdrawals successfully processed
    pub withdrawals_processed_total: IntCounter,

    /// Batch withdrawal statistics - min number of messages in a batch
    pub withdrawal_batch_min_messages: IntGauge,

    /// Batch withdrawal statistics - max number of messages in a batch
    pub withdrawal_batch_max_messages: IntGauge,

    /// Batch withdrawal statistics - last number of messages in a batch
    pub withdrawal_batch_last_messages: IntGauge,

    /// Track unique failed deposits and withdrawals to avoid double counting
    failed_deposit_ids: Arc<RwLock<HashSet<String>>>,
    failed_withdrawal_ids: Arc<RwLock<HashSet<String>>>,

    /// Track amounts of failed deposits and withdrawals
    failed_deposit_amounts: Arc<RwLock<HashMap<String, u64>>>,
    failed_withdrawal_amounts: Arc<RwLock<HashMap<String, u64>>>,

    /// Hub anchor point information (info metric with transaction ID as label)
    pub hub_anchor_point_info: GaugeVec,

    /// Last withdrawal anchor point information (info metric tracking last confirmed withdrawal)
    pub last_anchor_point_info: GaugeVec,

    /// Relayer receive address information (info metric with receive address)
    pub relayer_receive_address_info: GaugeVec,
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
            "kaspa_relayer_balance_sompi",
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
            "Total number of withdrawals successfully processed",
        )?;
        let _ = registry.register(Box::new(withdrawals_processed_total.clone()));

        let withdrawal_batch_min_messages = IntGauge::new(
            "kaspa_withdrawal_batch_min_messages",
            "Minimum number of messages in a withdrawal batch",
        )?;
        let _ = registry.register(Box::new(withdrawal_batch_min_messages.clone()));

        let withdrawal_batch_max_messages = IntGauge::new(
            "kaspa_withdrawal_batch_max_messages",
            "Maximum number of messages in a withdrawal batch",
        )?;
        let _ = registry.register(Box::new(withdrawal_batch_max_messages.clone()));

        let withdrawal_batch_last_messages = IntGauge::new(
            "kaspa_withdrawal_batch_last_messages",
            "Number of messages in the last withdrawal batch",
        )?;
        let _ = registry.register(Box::new(withdrawal_batch_last_messages.clone()));

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

        let relayer_receive_address_info = GaugeVec::new(
            Opts::new(
                "kaspa_relay_receive_address",
                "Relayer wallet receive address",
            ),
            &["receive_address"],
        )?;
        let _ = registry.register(Box::new(relayer_receive_address_info.clone()));

        let new_instance = Self {
            relayer_address_funds,
            funds_escrowed,
            total_funds_deposited,
            total_funds_withdrawn,
            pending_failed_withdrawals,
            pending_failed_deposits,
            failed_withdrawal_funds_sompi,
            failed_deposit_funds_sompi,
            confirmations_failed,
            confirmations_pending,
            escrow_utxo_count,
            deposits_processed_total,
            withdrawals_processed_total,
            withdrawal_batch_min_messages,
            withdrawal_batch_max_messages,
            withdrawal_batch_last_messages,
            failed_deposit_ids: Arc::new(RwLock::new(HashSet::new())),
            failed_withdrawal_ids: Arc::new(RwLock::new(HashSet::new())),
            failed_deposit_amounts: Arc::new(RwLock::new(HashMap::new())),
            failed_withdrawal_amounts: Arc::new(RwLock::new(HashMap::new())),
            hub_anchor_point_info,
            last_anchor_point_info,
            relayer_receive_address_info,
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

    /// Record successful deposit processing with amount and ID
    pub fn record_deposit_processed(&self, deposit_id: &str, amount_sompi: u64) {
        self.total_funds_deposited.inc_by(amount_sompi);
        self.deposits_processed_total.inc();

        // Remove from failed set if it was previously failed and decrement pending count and amount
        let mut failed_ids = self.failed_deposit_ids.write().unwrap();
        let mut failed_amounts = self.failed_deposit_amounts.write().unwrap();
        if failed_ids.remove(deposit_id) {
            // This deposit was previously failed, so decrement the pending count and amount
            self.pending_failed_deposits.dec();
            if let Some(failed_amount) = failed_amounts.remove(deposit_id) {
                self.failed_deposit_funds_sompi.sub(failed_amount as i64);
            }
        }
    }

    /// Record successful withdrawal processing with amount, ID, and message count
    pub fn record_withdrawal_processed(
        &self,
        withdrawal_id: &str,
        amount_sompi: u64,
        message_count: u64,
    ) {
        self.total_funds_withdrawn.inc_by(amount_sompi);
        self.withdrawals_processed_total.inc_by(message_count);

        // Update batch statistics
        self.update_withdrawal_batch_stats(message_count as i64);

        // Remove from failed set if it was previously failed and decrement pending count and amount
        let mut failed_ids = self.failed_withdrawal_ids.write().unwrap();
        let mut failed_amounts = self.failed_withdrawal_amounts.write().unwrap();
        if failed_ids.remove(withdrawal_id) {
            // This withdrawal was previously failed, so decrement the pending count and amount
            self.pending_failed_withdrawals.dec();
            if let Some(failed_amount) = failed_amounts.remove(withdrawal_id) {
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
    pub fn record_withdrawal_failed(&self, withdrawal_id: &str, amount_sompi: u64) -> bool {
        let mut failed_ids = self.failed_withdrawal_ids.write().unwrap();
        let mut failed_amounts = self.failed_withdrawal_amounts.write().unwrap();

        // Check if this withdrawal has already failed before
        if failed_ids.insert(withdrawal_id.to_string()) {
            // This is a new failure, increment pending failed withdrawals count and track amount
            self.pending_failed_withdrawals.inc();
            failed_amounts.insert(withdrawal_id.to_string(), amount_sompi);
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

    /// Update withdrawal batch statistics (min, max, last)
    pub fn update_withdrawal_batch_stats(&self, message_count: i64) {
        // Update min messages in batch
        let current_min = self.withdrawal_batch_min_messages.get();
        if current_min == 0 || message_count < current_min {
            self.withdrawal_batch_min_messages.set(message_count);
        }

        // Update max messages in batch
        let current_max = self.withdrawal_batch_max_messages.get();
        if message_count > current_max {
            self.withdrawal_batch_max_messages.set(message_count);
        }

        // Update last messages in batch
        self.withdrawal_batch_last_messages.set(message_count);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_metrics_creation() {
        let registry = Registry::new();
        let metrics = KaspaBridgeMetrics::new(&registry).expect("Failed to create metrics");

        // Test initial values
        assert_eq!(metrics.relayer_address_funds.get(), 0);
        assert_eq!(metrics.funds_escrowed.get(), 0);
        assert_eq!(metrics.pending_failed_withdrawals.get(), 0);
        assert_eq!(metrics.pending_failed_deposits.get(), 0);
        assert_eq!(metrics.failed_withdrawal_funds_sompi.get(), 0);
        assert_eq!(metrics.failed_deposit_funds_sompi.get(), 0);
        assert_eq!(metrics.confirmations_pending.get(), 0);
        assert_eq!(metrics.escrow_utxo_count.get(), 0);
        assert_eq!(metrics.deposits_processed_total.get(), 0);
        assert_eq!(metrics.withdrawals_processed_total.get(), 0);
        assert_eq!(metrics.withdrawal_batch_min_messages.get(), 0);
        assert_eq!(metrics.withdrawal_batch_max_messages.get(), 0);
        assert_eq!(metrics.withdrawal_batch_last_messages.get(), 0);
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

        // Test deposit processing
        let initial_total = metrics.total_funds_deposited.get();
        let initial_count = metrics.deposits_processed_total.get();
        metrics.record_deposit_processed("deposit_1", 100000);
        assert_eq!(
            metrics.total_funds_deposited.get() as u64,
            initial_total as u64 + 100000
        );
        assert_eq!(metrics.deposits_processed_total.get(), initial_count + 1);

        // Test withdrawal processing
        let initial_total = metrics.total_funds_withdrawn.get();
        let initial_count = metrics.withdrawals_processed_total.get();
        metrics.record_withdrawal_processed("withdrawal_1", 50000, 1);
        assert_eq!(
            metrics.total_funds_withdrawn.get() as u64,
            initial_total as u64 + 50000
        );
        assert_eq!(metrics.withdrawals_processed_total.get(), initial_count + 1);

        // Test failure tracking
        let is_new_failure = metrics.record_deposit_failed("deposit_2", 20000);
        assert!(is_new_failure);
        assert_eq!(metrics.pending_failed_deposits.get(), 1);
        assert_eq!(metrics.failed_deposit_funds_sompi.get(), 20000);

        // Test duplicate failure tracking (retry of same deposit)
        let is_new_failure = metrics.record_deposit_failed("deposit_2", 20000);
        assert!(!is_new_failure); // Should be false for duplicate
        assert_eq!(metrics.pending_failed_deposits.get(), 1); // Should NOT increment
        assert_eq!(metrics.failed_deposit_funds_sompi.get(), 20000); // Should NOT increment

        let is_new_failure = metrics.record_withdrawal_failed("withdrawal_2", 30000);
        assert!(is_new_failure);
        assert_eq!(metrics.pending_failed_withdrawals.get(), 1);
        assert_eq!(metrics.failed_withdrawal_funds_sompi.get(), 30000);

        // Test duplicate withdrawal failure
        let is_new_failure = metrics.record_withdrawal_failed("withdrawal_2", 30000);
        assert!(!is_new_failure);
        assert_eq!(metrics.pending_failed_withdrawals.get(), 1); // Should NOT increment
        assert_eq!(metrics.failed_withdrawal_funds_sompi.get(), 30000); // Should NOT increment

        // Test failure removal on success
        metrics.record_deposit_processed("deposit_2", 10000); // Process the previously failed deposit
        assert_eq!(metrics.pending_failed_deposits.get(), 0); // Should be decremented
        assert_eq!(metrics.failed_deposit_funds_sompi.get(), 0); // Amount should be removed

        metrics.record_withdrawal_processed("withdrawal_2", 5000, 1);
        assert_eq!(metrics.pending_failed_withdrawals.get(), 0); // Should be decremented
        assert_eq!(metrics.failed_withdrawal_funds_sompi.get(), 0); // Amount should be removed

        // Test confirmation metrics
        metrics.record_confirmation_failed();
        assert_eq!(metrics.confirmations_failed.get() as u64, 1);

        metrics.update_confirmations_pending(5);
        assert_eq!(metrics.confirmations_pending.get(), 5);

        // Test UTXO count
        metrics.update_escrow_utxo_count(10);
        assert_eq!(metrics.escrow_utxo_count.get(), 10);

        // Test batch statistics
        metrics.update_withdrawal_batch_stats(5);
        assert_eq!(metrics.withdrawal_batch_min_messages.get(), 1);
        assert_eq!(metrics.withdrawal_batch_max_messages.get(), 5);
        assert_eq!(metrics.withdrawal_batch_last_messages.get(), 5);

        metrics.update_withdrawal_batch_stats(10);
        assert_eq!(metrics.withdrawal_batch_min_messages.get(), 1);
        assert_eq!(metrics.withdrawal_batch_max_messages.get(), 10);
        assert_eq!(metrics.withdrawal_batch_last_messages.get(), 10);

        metrics.update_withdrawal_batch_stats(3);
        assert_eq!(metrics.withdrawal_batch_min_messages.get(), 1);
        assert_eq!(metrics.withdrawal_batch_max_messages.get(), 10);
        assert_eq!(metrics.withdrawal_batch_last_messages.get(), 3);
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
