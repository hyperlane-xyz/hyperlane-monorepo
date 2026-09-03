use std::{
    collections::{BTreeMap, HashMap},
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use maplit::hashmap;
use prometheus::{CounterVec, IntCounter, IntCounterVec, IntGauge, IntGaugeVec};

use hyperlane_base::CoreMetrics;
use hyperlane_core::{HyperlaneDomain, HyperlaneMessage, H256};

const UNKNOWN_APP_CONTEXT: &str = "Unknown";
const WAIT_EVENT: &str = "wait";
const RECOVERED_EVENT: &str = "recovered";
const ENDED_EVENT: &str = "ended";

#[derive(Clone, Copy, Debug)]
struct MetadataWaitStart {
    instant: Instant,
    unix_timestamp_seconds: i64,
}

#[derive(Debug, Default)]
struct AppMetadataWaits {
    by_message: HashMap<H256, MetadataWaitStart>,
    timestamp_counts: BTreeMap<i64, usize>,
}

impl AppMetadataWaits {
    fn insert(&mut self, message_id: H256, start: MetadataWaitStart) -> bool {
        match self.by_message.entry(message_id) {
            std::collections::hash_map::Entry::Occupied(_) => return false,
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert(start);
            }
        }
        self.timestamp_counts
            .entry(start.unix_timestamp_seconds)
            .and_modify(|count| *count = count.saturating_add(1))
            .or_insert(1);
        true
    }

    fn remove(&mut self, message_id: &H256) -> Option<MetadataWaitStart> {
        let removed = self.by_message.remove(message_id)?;
        let remove_timestamp = self
            .timestamp_counts
            .get_mut(&removed.unix_timestamp_seconds)
            .map(|count| {
                *count = count.saturating_sub(1);
                *count == 0
            })
            .unwrap_or_default();
        debug_assert!(
            self.timestamp_counts
                .contains_key(&removed.unix_timestamp_seconds),
            "tracked wait timestamp must have a count"
        );
        if remove_timestamp {
            self.timestamp_counts
                .remove(&removed.unix_timestamp_seconds);
        }
        Some(removed)
    }

    fn oldest_timestamp_seconds(&self) -> i64 {
        self.timestamp_counts
            .first_key_value()
            .map(|(timestamp, _)| *timestamp)
            .unwrap_or_default()
    }

    fn is_empty(&self) -> bool {
        self.by_message.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use prometheus::core::Collector;
    use prometheus::{Encoder, Registry, TextEncoder};

    use hyperlane_core::KnownHyperlaneDomain;

    use super::*;

    fn test_metrics() -> MessageSubmissionMetrics {
        let core_metrics = CoreMetrics::new("relayer", 9090, Registry::new()).unwrap();
        MessageSubmissionMetrics::new(
            &core_metrics,
            &HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
            &HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
        )
    }

    #[test]
    fn metadata_wait_metrics_track_retries_oldest_and_recovery_without_id_labels() {
        let metrics = test_metrics();
        let app_context = "test-app";
        let first_id = H256::from_low_u64_be(1);
        let second_id = H256::from_low_u64_be(2);
        let labels = [app_context, "ethereum", "arbitrum"];

        let first = metrics.record_metadata_wait(first_id, Some(app_context));
        assert!(first.first_observation);
        assert_eq!(
            metrics
                .metadata_wait_active
                .with_label_values(&labels)
                .get(),
            1
        );
        let oldest = metrics
            .metadata_wait_oldest_timestamp_seconds
            .with_label_values(&labels)
            .get();
        assert!(oldest > 0);

        let retry = metrics.record_metadata_wait(first_id, Some(app_context));
        assert!(!retry.first_observation);
        metrics.record_metadata_wait(second_id, Some(app_context));
        assert_eq!(
            metrics
                .metadata_wait_active
                .with_label_values(&labels)
                .get(),
            2
        );
        assert_eq!(
            metrics
                .metadata_wait_event_count
                .with_label_values(&[app_context, "ethereum", "arbitrum", WAIT_EVENT])
                .get(),
            3
        );

        assert!(metrics
            .finish_metadata_wait(first_id, Some(app_context), true)
            .is_some());
        assert_eq!(
            metrics
                .metadata_wait_event_count
                .with_label_values(&[app_context, "ethereum", "arbitrum", RECOVERED_EVENT])
                .get(),
            1
        );
        assert_eq!(
            metrics
                .metadata_wait_active
                .with_label_values(&labels)
                .get(),
            1
        );

        assert!(metrics
            .finish_metadata_wait(second_id, Some(app_context), false)
            .is_some());
        assert_eq!(
            metrics
                .metadata_wait_active
                .with_label_values(&labels)
                .get(),
            0
        );
        assert_eq!(
            metrics
                .metadata_wait_oldest_timestamp_seconds
                .with_label_values(&labels)
                .get(),
            0
        );

        let mut encoded = Vec::new();
        TextEncoder::new()
            .encode(&metrics.metadata_wait_event_count.collect(), &mut encoded)
            .unwrap();
        let encoded = String::from_utf8(encoded).unwrap();
        assert!(!encoded.contains("message_id"));
        assert!(!encoded.contains(&format!("{first_id:?}")));
        assert!(!encoded.contains(&format!("{second_id:?}")));
    }

    #[test]
    fn metadata_wait_oldest_uses_tracker_as_source_of_truth() {
        let metrics = test_metrics();
        let app_context = "test-app";
        let first_id = H256::from_low_u64_be(1);
        let second_id = H256::from_low_u64_be(2);
        let labels = [app_context, "ethereum", "arbitrum"];

        metrics.record_metadata_wait(first_id, Some(app_context));
        let expected_oldest = metrics
            .metadata_wait_oldest_timestamp_seconds
            .with_label_values(&labels)
            .get();

        // The gauge is an exported view, not authoritative tracker state.
        metrics
            .metadata_wait_oldest_timestamp_seconds
            .with_label_values(&labels)
            .set(1);
        metrics.record_metadata_wait(second_id, Some(app_context));
        assert_eq!(
            metrics
                .metadata_wait_oldest_timestamp_seconds
                .with_label_values(&labels)
                .get(),
            expected_oldest
        );
        assert!(metrics
            .finish_metadata_wait(second_id, Some(app_context), false)
            .is_some());

        assert_eq!(
            metrics
                .metadata_wait_oldest_timestamp_seconds
                .with_label_values(&labels)
                .get(),
            expected_oldest
        );
    }

    #[test]
    fn metadata_wait_tracker_keeps_an_ordered_oldest_timestamp() {
        let mut waits = AppMetadataWaits::default();
        let first_id = H256::from_low_u64_be(1);
        let second_id = H256::from_low_u64_be(2);
        let third_id = H256::from_low_u64_be(3);
        let now = Instant::now();

        for (message_id, unix_timestamp_seconds) in
            [(first_id, 20), (second_id, 10), (third_id, 10)]
        {
            assert!(waits.insert(
                message_id,
                MetadataWaitStart {
                    instant: now,
                    unix_timestamp_seconds,
                },
            ));
        }
        assert_eq!(waits.oldest_timestamp_seconds(), 10);

        waits.remove(&second_id).unwrap();
        assert_eq!(waits.oldest_timestamp_seconds(), 10);
        waits.remove(&third_id).unwrap();
        assert_eq!(waits.oldest_timestamp_seconds(), 20);
        waits.remove(&first_id).unwrap();
        assert_eq!(waits.oldest_timestamp_seconds(), 0);
    }
}

#[derive(Debug, Default)]
struct MetadataWaitTracker {
    by_app_context: Mutex<HashMap<String, AppMetadataWaits>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct MetadataWaitObservation {
    pub(crate) first_observation: bool,
    pub(crate) elapsed: Duration,
}

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
    pub metadata_build_count: IntCounterVec,
    /// Total number of seconds spent building different types of metadata.
    pub metadata_build_duration: CounterVec,
    /// Bounded wait-attempt and lifecycle events for validator-signature waits.
    pub metadata_wait_event_count: IntCounterVec,
    /// Messages currently waiting for validator signatures.
    pub metadata_wait_active: IntGaugeVec,
    /// Unix timestamp of the oldest active validator-signature wait.
    pub metadata_wait_oldest_timestamp_seconds: IntGaugeVec,
    metadata_wait_tracker: MetadataWaitTracker,
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
            last_known_nonce: metrics
                .last_known_message_nonce()
                .with_label_values(&["message_processed", origin]),
            messages_processed: metrics
                .messages_processed_count()
                .with_label_values(&[origin, destination]),
            metadata_build_count: metrics.metadata_build_count(),
            metadata_build_duration: metrics.metadata_build_duration(),
            metadata_wait_event_count: metrics.metadata_wait_event_count(),
            metadata_wait_active: metrics.metadata_wait_active(),
            metadata_wait_oldest_timestamp_seconds: metrics
                .metadata_wait_oldest_timestamp_seconds(),
            metadata_wait_tracker: MetadataWaitTracker::default(),
        }
    }

    pub fn update_nonce(&self, msg: &HyperlaneMessage) {
        // this is technically a race condition between `.get` and `.set` but worst case
        // the gauge should get corrected on the next update and is not an issue
        // with a ST runtime
        self.last_known_nonce
            .set(std::cmp::max(self.last_known_nonce.get(), msg.nonce as i64));
    }

    /// Add metrics on how long metadata building took for
    /// a specific ISM
    pub fn insert_metadata_build_metric(&self, params: MetadataBuildMetric) {
        let labels = hashmap! {
            "app_context" => params.app_context.as_deref().unwrap_or(UNKNOWN_APP_CONTEXT),
            "origin" => self.origin.as_str(),
            "remote" => self.destination.as_str(),
            "status" => if params.success { "success" } else { "failure" },
        };
        self.metadata_build_count.with(&labels).inc();
        self.metadata_build_duration
            .with(&labels)
            .inc_by(params.duration.as_secs_f64());
    }

    pub(crate) fn record_metadata_wait(
        &self,
        message_id: H256,
        app_context: Option<&str>,
    ) -> MetadataWaitObservation {
        let app_context = app_context.unwrap_or(UNKNOWN_APP_CONTEXT);
        let now = Instant::now();
        let unix_timestamp_seconds = i64::try_from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
        )
        .unwrap_or(i64::MAX);
        let mut waits = self
            .metadata_wait_tracker
            .by_app_context
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let app_waits = waits.entry(app_context.to_owned()).or_default();
        let start = app_waits
            .by_message
            .get(&message_id)
            .copied()
            .unwrap_or(MetadataWaitStart {
                instant: now,
                unix_timestamp_seconds,
            });
        let first_observation = app_waits.insert(message_id, start);
        if first_observation {
            let labels = [app_context, self.origin.as_str(), self.destination.as_str()];
            self.metadata_wait_active.with_label_values(&labels).inc();
            self.metadata_wait_oldest_timestamp_seconds
                .with_label_values(&labels)
                .set(app_waits.oldest_timestamp_seconds());
        }

        self.metadata_wait_event_count
            .with_label_values(&[
                app_context,
                self.origin.as_str(),
                self.destination.as_str(),
                WAIT_EVENT,
            ])
            .inc();

        MetadataWaitObservation {
            first_observation,
            elapsed: now.saturating_duration_since(start.instant),
        }
    }

    pub(crate) fn finish_metadata_wait(
        &self,
        message_id: H256,
        app_context: Option<&str>,
        recovered: bool,
    ) -> Option<Duration> {
        let app_context = app_context.unwrap_or(UNKNOWN_APP_CONTEXT);
        let labels = [app_context, self.origin.as_str(), self.destination.as_str()];
        let mut waits = self
            .metadata_wait_tracker
            .by_app_context
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let app_waits = waits.get_mut(app_context)?;
        let removed = app_waits.remove(&message_id)?;
        let next_oldest = app_waits.oldest_timestamp_seconds();
        let remove_app_context = app_waits.is_empty();
        if remove_app_context {
            waits.remove(app_context);
        }

        self.metadata_wait_active.with_label_values(&labels).dec();
        self.metadata_wait_oldest_timestamp_seconds
            .with_label_values(&labels)
            .set(next_oldest);
        self.metadata_wait_event_count
            .with_label_values(&[
                app_context,
                self.origin.as_str(),
                self.destination.as_str(),
                if recovered {
                    RECOVERED_EVENT
                } else {
                    ENDED_EVENT
                },
            ])
            .inc();

        Some(removed.instant.elapsed())
    }
}
