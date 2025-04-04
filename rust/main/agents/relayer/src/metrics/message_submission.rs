use std::time::Duration;

use maplit::hashmap;
use prometheus::{CounterVec, IntCounter, IntCounterVec, IntGauge};

use hyperlane_base::CoreMetrics;
use hyperlane_core::{HyperlaneDomain, HyperlaneMessage};

/// Expected label names for the metric.
pub const METADATA_BUILD_COUNT_LABELS: &[&str] =
    &["app_context", "origin", "destination", "status"];
/// Help string for the metric.
pub const METADATA_BUILD_COUNT_HELP: &str = "Total number of times metadata was build";

/// Expected label names for the metric.
pub const METADATA_BUILD_DURATION_LABELS: &[&str] =
    &["app_context", "origin", "destination", "status"];
/// Help string for the metric.
pub const METADATA_BUILD_DURATION_HELP: &str = "Total number of times metadata was build";

#[derive(Clone, Debug)]
pub struct MetadataBuildMetric {
    pub app_context: Option<String>,
    pub success: bool,
    pub duration: Duration,
}

#[derive(Debug)]
pub struct MessageSubmissionMetrics {
    // Origin and destination chain names
    pub origin: String,
    pub destination: String,

    // Fields are public for testing purposes
    pub last_known_nonce: IntGauge,
    pub messages_processed: IntCounter,

    /// Number of times we've built metadata
    pub metadata_build_count: Option<IntCounterVec>,
    /// Total number of seconds spent building different types of metadata.
    pub metadata_build_duration: Option<CounterVec>,
}

impl MessageSubmissionMetrics {
    pub fn new(
        metrics: &CoreMetrics,
        origin: &HyperlaneDomain,
        destination: &HyperlaneDomain,
    ) -> Self {
        let origin = origin.name();
        let destination = destination.name();
        Self {
            origin: origin.to_string(),
            destination: destination.to_string(),
            last_known_nonce: metrics.last_known_message_nonce().with_label_values(&[
                "message_processed",
                origin,
                destination,
            ]),
            messages_processed: metrics
                .messages_processed_count()
                .with_label_values(&[origin, destination]),
            metadata_build_count: metrics
                .new_int_counter(
                    "metadata_build_count",
                    METADATA_BUILD_COUNT_HELP,
                    METADATA_BUILD_COUNT_LABELS,
                )
                .ok(),
            metadata_build_duration: metrics
                .new_counter(
                    "metadata_build_duration",
                    METADATA_BUILD_DURATION_HELP,
                    METADATA_BUILD_DURATION_LABELS,
                )
                .ok(),
        }
    }

    /// Add metrics on how long metadata building took for
    /// a specific ISM
    pub fn insert_metadata_build_metric(&self, params: MetadataBuildMetric) {
        let labels = hashmap! {
            "app_context" => params.app_context.as_deref().unwrap_or("Unknown"),
            "origin" => self.origin.as_str(),
            "destination" => self.destination.as_str(),
            "status" => if params.success { "success" } else { "failure" },
        };
        if let Some(counter) = &self.metadata_build_count {
            tracing::debug!("Incrementing labels count");
            counter.with(&labels).inc();
        };
        if let Some(counter) = &self.metadata_build_duration {
            tracing::debug!("Incrementing labels duration");
            counter.with(&labels).inc_by(params.duration.as_secs_f64())
        };
    }

    pub fn update_nonce(&self, msg: &HyperlaneMessage) {
        // this is technically a race condition between `.get` and `.set` but worst case
        // the gauge should get corrected on the next update and is not an issue
        // with a ST runtime
        self.last_known_nonce
            .set(std::cmp::max(self.last_known_nonce.get(), msg.nonce as i64));
    }
}
