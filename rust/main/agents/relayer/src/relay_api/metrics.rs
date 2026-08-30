use std::time::Duration;

use prometheus::{Histogram, HistogramOpts, IntCounterVec, Opts, Registry};

#[derive(Clone)]
pub struct RelayApiMetrics {
    /// Total relay API requests received
    pub requests_total: IntCounterVec,
    processor_admission_duration_seconds: Histogram,
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

        let processor_admission_duration_seconds = Histogram::with_opts(
            HistogramOpts::new(
                "hyperlane_relay_api_processor_admission_duration_seconds",
                "Time spent reserving bounded processor ingress for a relay API request",
            )
            .buckets(vec![0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5]),
        )?;
        registry.register(Box::new(processor_admission_duration_seconds.clone()))?;

        Ok(Self {
            requests_total,
            processor_admission_duration_seconds,
        })
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

    pub fn observe_processor_admission(&self, duration: Duration) {
        self.processor_admission_duration_seconds
            .observe(duration.as_secs_f64());
    }
}
