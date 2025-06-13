use hyperlane_core::U256;
use prometheus::{
    opts, register_int_gauge_vec_with_registry, Encoder, IntGauge, IntGaugeVec, Registry,
};

const METRICS_NAMESPACE: &str = "hyperlane_lander_ethereum_adapter";

/// Macro to prefix a string with the namespace.
fn namespaced(name: &str) -> String {
    format!("{}_{}", METRICS_NAMESPACE, name)
}

#[derive(Clone)]
pub struct EthereumAdapterMetrics {
    /// Currently finalized nonce for each destination
    finalized_nonce: IntGaugeVec,
    /// Upper nonce, namely the nonce which can be used next for each destination
    upper_nonce: IntGaugeVec,
}

impl EthereumAdapterMetrics {
    pub fn new(registry: &Registry) -> eyre::Result<Self> {
        let finalized_nonce = register_int_gauge_vec_with_registry!(
            opts!(
                namespaced("finalized_nonce"),
                "Currently finalized nonce for each destination",
            ),
            &["destination",],
            registry.clone()
        )?;

        let upper_nonce = register_int_gauge_vec_with_registry!(
            opts!(
                namespaced("upper_nonce"),
                "Currently upper nonce for each destination",
            ),
            &["destination",],
            registry.clone()
        )?;

        Ok(Self {
            finalized_nonce,
            upper_nonce,
        })
    }

    pub fn set_finalized_nonce(&self, destination: &str, value: &U256) {
        self.finalized_nonce
            .with_label_values(&[destination])
            .set(value.as_u64() as i64);
    }

    pub fn set_upper_nonce(&self, destination: &str, value: &U256) {
        self.upper_nonce
            .with_label_values(&[destination])
            .set(value.as_u64() as i64);
    }

    #[cfg(test)]
    pub fn dummy_instance() -> Self {
        let registry = Registry::new();
        let instance = Self::new(&registry);
        instance.unwrap()
    }

    #[cfg(test)]
    pub fn get_finalized_nonce(&self, destination: &str) -> i64 {
        self.finalized_nonce.with_label_values(&[destination]).get()
    }

    #[cfg(test)]
    pub fn get_upper_nonce(&self, destination: &str) -> i64 {
        self.upper_nonce.with_label_values(&[destination]).get()
    }
}
