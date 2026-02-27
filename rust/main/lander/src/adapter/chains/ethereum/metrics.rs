use ethers_core::abi::Int;
use prometheus::{
    opts, register_int_gauge_vec_with_registry, register_int_gauge_with_registry, Encoder,
    IntCounter, IntCounterVec, IntGauge, IntGaugeVec, Registry,
};
use serde_json::to_string;

use hyperlane_core::{HyperlaneDomain, U256};

pub const LABEL_BATCHED_TRANSACTION_SUCCESS: &str = "success";
pub const LABEL_BATCHED_TRANSACTION_FAILED: &str = "failed";

#[derive(Clone)]
pub struct EthereumAdapterMetrics {
    domain: HyperlaneDomain,
    /// Batch transaction metrics
    batched_transaction: IntCounterVec,
    /// Currently finalized nonce for each destination
    finalized_nonce: IntGauge,
    /// Upper nonce, namely the nonce which can be used next for each destination
    upper_nonce: IntGauge,
    /// Counts how many times we've noticed the nonce in tx is different from nonce
    /// stored in db
    mismatch_nonce: IntGauge,
    /// Number of nonces seen in reorg windows.
    reorged_nonces: IntCounter,
    /// Whether oversized reorg processing needs manual intervention.
    reorg_manual_intervention_required: IntGauge,
}

impl EthereumAdapterMetrics {
    pub fn new(
        domain: HyperlaneDomain,
        batched_transaction: IntCounterVec,
        finalized_nonce: IntGauge,
        upper_nonce: IntGauge,
        mismatch_nonce: IntGauge,
        reorged_nonces: IntCounter,
        reorg_manual_intervention_required: IntGauge,
    ) -> Self {
        Self {
            domain,
            batched_transaction,
            finalized_nonce,
            upper_nonce,
            mismatch_nonce,
            reorged_nonces,
            reorg_manual_intervention_required,
        }
    }

    pub fn set_finalized_nonce(&self, value: &U256) {
        self.finalized_nonce.set(value.as_u64() as i64);
    }

    pub fn set_upper_nonce(&self, value: &U256) {
        self.upper_nonce.set(value.as_u64() as i64);
    }

    pub fn increment_batched_transactions(&self, status: &str, amount: u64) {
        self.get_batched_transactions()
            .with_label_values(&[self.domain.name(), status])
            .inc_by(amount);
    }

    pub fn get_batched_transactions(&self) -> &IntCounterVec {
        &self.batched_transaction
    }

    pub fn increment_mismatch_nonce(&self) {
        self.get_mismatched_nonce().inc();
    }

    pub fn get_mismatched_nonce(&self) -> &IntGauge {
        &self.mismatch_nonce
    }

    pub fn increment_reorged_nonces(&self, amount: u64) {
        self.reorged_nonces.inc_by(amount);
    }

    pub fn set_reorg_manual_intervention_required(&self, required: bool) {
        self.reorg_manual_intervention_required
            .set(if required { 1 } else { 0 });
    }
}

#[cfg(test)]
impl EthereumAdapterMetrics {
    pub fn dummy_instance() -> Self {
        use crate::DispatcherMetrics;

        let domain = "test1";
        let signer = "test_signer";
        let dispatcher_metrics = DispatcherMetrics::dummy_instance();

        Self::new(
            HyperlaneDomain::new_test_domain(domain),
            dispatcher_metrics.get_batched_transactions(),
            dispatcher_metrics.get_finalized_nonce(domain, signer),
            dispatcher_metrics.get_upper_nonce(domain, signer),
            dispatcher_metrics.get_mismatched_nonce(domain, signer),
            dispatcher_metrics.get_reorged_nonces(domain, signer),
            dispatcher_metrics.get_reorg_manual_intervention_required(domain, signer),
        )
    }

    pub fn get_finalized_nonce(&self) -> i64 {
        self.finalized_nonce.get()
    }

    pub fn get_upper_nonce(&self) -> i64 {
        self.upper_nonce.get()
    }
}
