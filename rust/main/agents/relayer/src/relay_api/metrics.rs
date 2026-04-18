use prometheus::{IntCounterVec, Opts, Registry};

#[derive(Clone)]
pub struct RelayApiMetrics {
    /// Total relay API requests received
    pub requests_total: IntCounterVec,
}

impl RelayApiMetrics {
    pub fn new(registry: &Registry) -> Result<Self, prometheus::Error> {
        let requests_total = IntCounterVec::new(
            Opts::new(
                "hyperlane_relay_api_requests_total",
                "Total relay API requests received",
            ),
            &["status", "error_type"],
        )?;

        registry.register(Box::new(requests_total.clone()))?;

        Ok(Self { requests_total })
    }

    pub fn inc_success(&self) {
        self.requests_total
            .with_label_values(&["success", ""])
            .inc();
    }

    pub fn inc_failure(&self, error_type: &str) {
        self.requests_total
            .with_label_values(&["failure", error_type])
            .inc();
    }
}
