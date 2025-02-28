use std::collections::HashMap;
use std::fmt::{Debug, Formatter};
use std::sync::OnceLock;
use std::time;

use eyre::Result;
use hyperlane_core::{HyperlaneDomain, H160};
use prometheus::{
    histogram_opts, labels, opts, register_counter_vec_with_registry,
    register_gauge_vec_with_registry, register_histogram_vec_with_registry,
    register_int_counter_vec_with_registry, register_int_gauge_vec_with_registry, CounterVec,
    Encoder, GaugeVec, HistogramVec, IntCounterVec, IntGaugeVec, Registry,
};
use tokio::sync::RwLock;

use ethers_prometheus::middleware::MiddlewareMetrics;
use hyperlane_metric::prometheus_metric::PrometheusClientMetrics;

use crate::metrics::{
    json_rpc_client::create_json_rpc_client_metrics, provider::create_provider_metrics,
};

/// Macro to prefix a string with the namespace.
macro_rules! namespaced {
    ($name:expr) => {
        format!("{}_{}", super::NAMESPACE, $name)
    };
}

/// Metrics for a particular domain
pub struct CoreMetrics {
    /// Metrics registry for adding new metrics and gathering reports
    registry: Registry,
    const_labels: HashMap<String, String>,
    listen_port: u16,
    agent_name: String,

    span_durations: CounterVec,
    span_counts: IntCounterVec,
    span_events: IntCounterVec,
    last_known_message_nonce: IntGaugeVec,
    latest_tree_insertion_index: IntGaugeVec,
    submitter_queue_length: IntGaugeVec,

    operations_processed_count: IntCounterVec,
    messages_processed_count: IntCounterVec,

    latest_checkpoint: IntGaugeVec,

    /// Set of metrics that tightly wrap the JsonRpcClient for use with the
    /// quorum provider.
    client_metrics: OnceLock<PrometheusClientMetrics>,

    /// Set of provider-specific metrics. These only need to get created once.
    provider_metrics: OnceLock<MiddlewareMetrics>,

    /// Metrics that are used to observe validator sets.
    pub validator_metrics: ValidatorObservabilityMetricManager,
}

impl CoreMetrics {
    /// Track metrics for a particular agent name.
    ///
    /// - `for_agent` name of the agent these metrics are tracking.
    /// - `listen_port` port to start the HTTP server on.
    /// - `registry` prometheus registry to attach the metrics to
    pub fn new(for_agent: &str, listen_port: u16, registry: Registry) -> prometheus::Result<Self> {
        let const_labels: HashMap<String, String> = labels! {
            namespaced!("baselib_version") => env!("CARGO_PKG_VERSION").into(),
            "agent".into() => for_agent.into(),
        };
        let const_labels_ref = const_labels
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect::<HashMap<_, _>>();

        let span_durations = register_counter_vec_with_registry!(
            opts!(
                namespaced!("span_duration_seconds"),
                "Duration from tracing span creation to span destruction",
                const_labels_ref
            ),
            &["span_name", "span_target"],
            registry
        )?;

        let span_counts = register_int_counter_vec_with_registry!(
            opts!(
                namespaced!("span_count"),
                "Number of times a span was exited",
                const_labels_ref
            ),
            &["span_name", "span_target"],
            registry
        )?;

        let span_events = register_int_counter_vec_with_registry!(
            opts!(
                namespaced!("span_events_total"),
                "Number of span events (logs and time metrics) emitted by level",
                const_labels_ref
            ),
            &["event_level"],
            registry
        )?;

        let last_known_message_nonce = register_int_gauge_vec_with_registry!(
            opts!(
                namespaced!("last_known_message_nonce"),
                "Last known message nonce",
                const_labels_ref
            ),
            &["phase", "origin", "remote"],
            registry
        )?;

        let latest_tree_insertion_index = register_int_gauge_vec_with_registry!(
            opts!(
                namespaced!("latest_tree_insertion_index"),
                "Latest leaf index inserted into the merkle tree",
                const_labels_ref
            ),
            &["origin"],
            registry
        )?;

        let observed_validator_latest_index = register_int_gauge_vec_with_registry!(
            opts!(
                namespaced!("observed_validator_latest_index"),
                "The latest observed latest signed checkpoint indices per validator, from the perspective of the relayer",
                const_labels_ref
            ),
            &[
                "origin",
                "destination",
                "validator",
                "app_context",
            ],
            registry
        )?;

        let submitter_queue_length = register_int_gauge_vec_with_registry!(
            opts!(
                namespaced!("submitter_queue_length"),
                "Submitter queue length",
                const_labels_ref
            ),
            &["remote", "queue_name", "operation_status", "app_context"],
            registry
        )?;

        let latest_checkpoint = register_int_gauge_vec_with_registry!(
            opts!(
                namespaced!("latest_checkpoint"),
                "Mailbox latest checkpoint",
                const_labels_ref
            ),
            &["phase", "chain"],
            registry
        )?;

        let operations_processed_count = register_int_counter_vec_with_registry!(
            opts!(
                namespaced!("operations_processed_count"),
                "Number of operations processed",
                const_labels_ref
            ),
            &["phase", "chain"],
            registry
        )?;

        let messages_processed_count = register_int_counter_vec_with_registry!(
            opts!(
                namespaced!("messages_processed_count"),
                "Number of messages processed",
                const_labels_ref
            ),
            &["origin", "remote"],
            registry
        )?;

        Ok(Self {
            agent_name: for_agent.into(),
            registry,
            listen_port,
            const_labels,

            span_durations,
            span_counts,
            span_events,
            last_known_message_nonce,
            latest_tree_insertion_index,

            submitter_queue_length,

            operations_processed_count,
            messages_processed_count,

            latest_checkpoint,

            client_metrics: OnceLock::new(),
            provider_metrics: OnceLock::new(),

            validator_metrics: ValidatorObservabilityMetricManager::new(
                observed_validator_latest_index.clone(),
            ),
        })
    }

    /// Create the provider metrics attached to this core metrics instance.
    pub fn provider_metrics(&self) -> MiddlewareMetrics {
        self.provider_metrics
            .get_or_init(|| {
                create_provider_metrics(self).expect("Failed to create provider metrics!")
            })
            .clone()
    }

    /// Create the json rpc provider metrics attached to this core metrics
    /// instance.
    pub fn client_metrics(&self) -> PrometheusClientMetrics {
        self.client_metrics
            .get_or_init(|| {
                create_json_rpc_client_metrics(self).expect("Failed to create rpc client metrics!")
            })
            .clone()
    }

    /// Create and register a new int gauge.
    pub fn new_int_gauge(
        &self,
        metric_name: &str,
        help: &str,
        labels: &[&str],
    ) -> Result<IntGaugeVec> {
        Ok(register_int_gauge_vec_with_registry!(
            opts!(namespaced!(metric_name), help, self.const_labels_str()),
            labels,
            self.registry
        )?)
    }

    /// Create and register a new gauge.
    pub fn new_gauge(&self, metric_name: &str, help: &str, labels: &[&str]) -> Result<GaugeVec> {
        Ok(register_gauge_vec_with_registry!(
            opts!(namespaced!(metric_name), help, self.const_labels_str()),
            labels,
            self.registry
        )?)
    }

    /// Create and register a new counter.
    pub fn new_counter(
        &self,
        metric_name: &str,
        help: &str,
        labels: &[&str],
    ) -> Result<CounterVec> {
        Ok(register_counter_vec_with_registry!(
            opts!(namespaced!(metric_name), help, self.const_labels_str()),
            labels,
            self.registry
        )?)
    }

    /// Create and register a new int counter.
    pub fn new_int_counter(
        &self,
        metric_name: &str,
        help: &str,
        labels: &[&str],
    ) -> Result<IntCounterVec> {
        Ok(register_int_counter_vec_with_registry!(
            opts!(namespaced!(metric_name), help, self.const_labels_str()),
            labels,
            self.registry
        )?)
    }

    /// Create and register a new histogram.
    pub fn new_histogram(
        &self,
        metric_name: &str,
        help: &str,
        labels: &[&str],
        buckets: Vec<f64>,
    ) -> Result<HistogramVec> {
        Ok(register_histogram_vec_with_registry!(
            histogram_opts!(
                namespaced!(metric_name),
                help,
                buckets,
                self.const_labels.clone()
            ),
            labels,
            self.registry
        )?)
    }

    /// Reports the current highest message nonce at multiple phases of the
    /// relaying process. There may be messages that have not reached a certain
    /// stage, such as being fully processed, even if the reported nonce is
    /// higher than that message's nonce.
    ///
    /// Some phases are not able to report the remote chain, but origin chain is
    /// always reported.
    ///
    /// Labels:
    /// - `phase`: The phase the nonce is being tracked at, see below.
    /// - `origin`: Origin chain the message comes from. Can be "any"
    /// - `remote`: Remote chain for the message. This will skip values because
    ///   the nonces are contiguous by origin not remote. Can be "any"
    ///
    /// The following phases are implemented:
    /// - `dispatch`: Highest nonce which has been indexed on the mailbox
    ///   contract syncer and stored in the relayer DB.
    /// - `processor_loop`: Highest nonce which the MessageProcessor loop has
    ///   gotten to but not attempted to send it.
    /// - `message_processed`: When a nonce was processed as part of the
    ///   MessageProcessor loop.
    pub fn last_known_message_nonce(&self) -> IntGaugeVec {
        self.last_known_message_nonce.clone()
    }

    /// Reports the current highest leaf index which was inserted into the merkle tree.
    ///
    /// Labels:
    /// - `origin`: Origin chain the leaf index is being tracked at.
    pub fn latest_tree_insertion_index(&self) -> IntGaugeVec {
        self.latest_tree_insertion_index.clone()
    }

    /// Latest message nonce in the validator.
    ///
    /// Phase:
    /// - `validator_observed`: When the validator has observed the checkpoint
    ///   on the mailbox contract.
    /// - `validator_processed`: When the validator has written this checkpoint.
    pub fn latest_checkpoint(&self) -> IntGaugeVec {
        self.latest_checkpoint.clone()
    }

    /// Measure of the queue lengths in Submitter instances
    ///
    /// Labels:
    /// - `remote`: Remote chain the queue is for.
    /// - `queue_name`: Which queue the message is in.
    pub fn submitter_queue_length(&self) -> IntGaugeVec {
        self.submitter_queue_length.clone()
    }

    /// The number of operations successfully submitted by this process during
    /// its lifetime.
    ///
    /// Tracks the number of operations to go through each stage.
    ///
    /// Labels:
    /// - `phase`: Phase of the operation submission process.
    /// - `chain`: Chain the operation was submitted to.
    ///
    /// The following phases have been implemented:
    /// - `prepared`: When the operation has been prepared for submission. This
    ///   is a pipelining step that happens before submission and may need to be
    ///   re-done.
    /// - `submitted`: When the operation has been submitted to the chain but is
    ///   not yet certain to be included after a re-org.
    /// - `confirmed`: When the operation has been confirmed to have made it
    ///   into the chain after the reorg window has passed.
    /// - `reorged`: When the operation was not included and needs to be
    ///   reprocessed.
    /// - `failed`: When some part of the pipeline failed. The operation may
    ///   still be retried later.
    /// - `dropped`: When the operation was dropped from the pipeline. This may
    ///   or may not be because of an error.
    pub fn operations_processed_count(&self) -> IntCounterVec {
        self.operations_processed_count.clone()
    }

    /// The number of messages successfully submitted by this process during its
    /// lifetime.
    ///
    /// The value of
    /// `hyperlane_last_known_message_nonce{phase=message_processed}`
    /// should refer to the maximum nonce value we ever successfully
    /// delivered. Since deliveries can happen out-of-index-order, we
    /// separately track this counter referring to the number of successfully
    /// delivered messages.
    ///
    /// Labels:
    /// - `origin`: Chain the message came from.
    /// - `remote`: Chain we delivered the message to.
    pub fn messages_processed_count(&self) -> IntCounterVec {
        self.messages_processed_count.clone()
    }

    /// Measure of span durations provided by tracing.
    ///
    /// Labels:
    /// - `span_name`: name of the span. e.g. the function name.
    /// - `span_target`: a string that categorizes part of the system where the
    ///   span or event occurred. e.g. module path.
    pub fn span_duration_seconds(&self) -> CounterVec {
        self.span_durations.clone()
    }

    /// Measure of measuring how many given times a span was exited.
    ///
    /// Labels:
    /// - `span_name`: name of the span. e.g. the function name.
    /// - `span_target`: a string that categorizes part of the system where the
    ///   span or event occurred. e.g. module path.
    pub fn span_count(&self) -> IntCounterVec {
        self.span_counts.clone()
    }

    /// Counts of tracing (logging framework) span events.
    ///
    /// Tracking the number of events emitted helps us verify logs are not being
    /// dropped and provides a quick way to query error and warning counts.
    ///
    /// Labels:
    /// - `event_level`: level of the event, i.e. trace, debug, info, warn,
    ///   error.
    pub fn span_events(&self) -> IntCounterVec {
        self.span_events.clone()
    }

    /// Gather available metrics into an encoded (plaintext, OpenMetrics format)
    /// report.
    pub fn gather(&self) -> prometheus::Result<Vec<u8>> {
        let collected_metrics = self.registry.gather();
        let mut out_buf = Vec::with_capacity(1024 * 64);
        let encoder = prometheus::TextEncoder::new();
        encoder.encode(&collected_metrics, &mut out_buf)?;
        Ok(out_buf)
    }

    /// Get the name of this agent, e.g. "relayer"
    pub fn agent_name(&self) -> &str {
        &self.agent_name
    }

    fn const_labels_str(&self) -> HashMap<&str, &str> {
        self.const_labels
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect()
    }

    /// Get the difference between the latest observed checkpoint and the latest signed checkpoint.
    ///
    /// This is useful for reporting the health of the validator and reporting it via EigenNodeAPI
    pub fn get_latest_checkpoint_validator_delta(&self, origin_chain: HyperlaneDomain) -> i64 {
        let observed_checkpoint = self
            .latest_checkpoint()
            .with_label_values(&["validator_observed", origin_chain.name()])
            .get();
        let signed_checkpoint = self
            .latest_checkpoint()
            .with_label_values(&["validator_processed", origin_chain.name()])
            .get();
        observed_checkpoint - signed_checkpoint
    }
}

impl Debug for CoreMetrics {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "CoreMetrics {{ agent_name: {}, listen_port: {:?} }}",
            self.agent_name, self.listen_port
        )
    }
}

#[derive(Debug, Eq, PartialEq, Hash)]
struct AppContextKey {
    origin: HyperlaneDomain,
    destination: HyperlaneDomain,
    app_context: String,
}

/// If this period has elapsed since a validator was last updated in the metrics,
/// it will be removed from the metrics.
const MIN_VALIDATOR_METRIC_RESET_PERIOD: time::Duration = time::Duration::from_secs(60 * 3);

/// Manages metrics for observing sets of validators.
pub struct ValidatorObservabilityMetricManager {
    observed_validator_latest_index: IntGaugeVec,

    // AppContextKey -> Validator -> Last updated at
    // Used to track the last time a validator was updated in the metrics, allowing
    // for the removal of validators that have not been updated in a while to support
    // changing validator sets.
    app_context_validators: RwLock<HashMap<AppContextKey, HashMap<H160, time::Instant>>>,
}

impl ValidatorObservabilityMetricManager {
    fn new(observed_validator_latest_index: IntGaugeVec) -> Self {
        Self {
            observed_validator_latest_index,
            app_context_validators: RwLock::new(HashMap::new()),
        }
    }

    /// Updates the metrics with the latest checkpoint index for each validator
    /// in a given set.
    pub async fn set_validator_latest_checkpoints(
        &self,
        origin: &HyperlaneDomain,
        destination: &HyperlaneDomain,
        app_context: String,
        latest_checkpoints: &HashMap<H160, Option<u32>>,
    ) {
        let key = AppContextKey {
            origin: origin.clone(),
            destination: destination.clone(),
            app_context: app_context.clone(),
        };

        let mut app_context_validators = self.app_context_validators.write().await;

        let mut new_set = HashMap::new();

        // First, attempt to clear out all previous metrics for the app context.
        // This is necessary because the set of validators may have changed.
        if let Some(prev_validators) = app_context_validators.get(&key) {
            // If the validator was last updated in the metrics more than
            // a certain period ago, remove it from the metrics.
            // Some leniency is given here to allow this function to be called
            // multiple times in a short period without clearing out the metrics,
            // e.g. when a message's ISM aggregates multiple different validator sets.
            for (validator, last_updated_at) in prev_validators {
                if last_updated_at.elapsed() < MIN_VALIDATOR_METRIC_RESET_PERIOD {
                    // If the last metric refresh was too recent, keep the validator
                    // and the time of its last metric update.
                    new_set.insert(*validator, *last_updated_at);
                    continue;
                }
                // We unwrap because an error here occurs if the # of labels
                // provided is incorrect, and we'd like to loudly fail in e2e if that
                // happens.
                self.observed_validator_latest_index
                    .remove_label_values(&[
                        origin.as_ref(),
                        destination.as_ref(),
                        &format!("0x{:x}", validator).to_lowercase(),
                        &app_context,
                    ])
                    .unwrap();
            }
        }

        // Then set the new metrics and update the cached set of validators.
        for (validator, latest_checkpoint) in latest_checkpoints {
            self.observed_validator_latest_index
                .with_label_values(&[
                    origin.as_ref(),
                    destination.as_ref(),
                    &format!("0x{:x}", validator).to_lowercase(),
                    &app_context,
                ])
                // If the latest checkpoint is None, set to -1 to indicate that
                // the validator did not provide a valid latest checkpoint index.
                .set(latest_checkpoint.map(|i| i as i64).unwrap_or(-1));
            new_set.insert(*validator, time::Instant::now());
        }
        app_context_validators.insert(key, new_set);
    }

    /// Gauge for reporting recently observed latest checkpoint indices for validator sets.
    /// The entire set for an app context should be updated at once, and it should be updated
    /// in a way that is robust to validator set changes.
    /// Set to -1 to indicate a validator did not provide a valid latest checkpoint index.
    /// Note that it's possible for an app to be using an aggregation ISM of more than one
    /// validator set. If these sets are different, there is no label built into the metric
    /// to distinguish them.
    ///
    /// Labels:
    /// - `origin`: Origin chain
    /// - `destination`: Destination chain
    /// - `validator`: Address of the validator
    /// - `app_context`: App context for the validator set
    pub fn observed_validator_latest_index(&self) -> IntGaugeVec {
        self.observed_validator_latest_index.clone()
    }
}
