use ethers_core::abi::Int;
use prometheus::{
    opts, register_int_gauge_vec_with_registry, register_int_gauge_with_registry, Encoder,
    IntGauge, IntGaugeVec, Registry,
};
use serde_json::to_string;

use hyperlane_core::U256;

#[derive(Clone)]
pub struct EthereumAdapterMetrics {
    /// Currently finalized nonce for each destination
    finalized_nonce: IntGauge,
    /// Upper nonce, namely the nonce which can be used next for each destination
    upper_nonce: IntGauge,
}

impl EthereumAdapterMetrics {
    pub fn new(finalized_nonce: IntGauge, upper_nonce: IntGauge) -> Self {
        Self {
            finalized_nonce,
            upper_nonce,
        }
    }

    pub fn set_finalized_nonce(&self, value: &U256) {
        self.finalized_nonce.set(value.as_u64() as i64);
    }

    pub fn set_upper_nonce(&self, value: &U256) {
        self.upper_nonce.set(value.as_u64() as i64);
    }
}

#[cfg(test)]
impl EthereumAdapterMetrics {
    pub fn dummy_instance() -> Self {
        use crate::DispatcherMetrics;

        let domain = "test1";
        let signer = "test_signer";
        let dispatcher_metrics = DispatcherMetrics::dummy_instance();
        let metrics = Self::new(
            dispatcher_metrics.get_finalized_nonce(domain, signer),
            dispatcher_metrics.get_upper_nonce(domain, signer),
        );
        metrics
    }

    pub fn get_finalized_nonce(&self) -> i64 {
        self.finalized_nonce.get()
    }

    pub fn get_upper_nonce(&self) -> i64 {
        self.upper_nonce.get()
    }
}
