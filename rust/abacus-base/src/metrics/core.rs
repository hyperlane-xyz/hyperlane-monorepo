use std::collections::HashMap;
use std::fmt::{Debug, Formatter};
use std::sync::Arc;

use eyre::Result;
use once_cell::sync::OnceCell;
use prometheus::{
    histogram_opts, labels, opts, register_counter_vec_with_registry,
    register_gauge_vec_with_registry, register_histogram_vec_with_registry,
    register_int_counter_vec_with_registry, register_int_gauge_vec_with_registry, CounterVec,
    Encoder, GaugeVec, HistogramVec, IntCounterVec, IntGaugeVec, Registry,
};
use tokio::task::JoinHandle;

use ethers_prometheus::middleware::MiddlewareMetrics;

use crate::metrics::provider::create_provider_metrics;

use super::NAMESPACE;

/// Recommended default histogram buckets for network communication.
pub const NETWORK_HISTOGRAM_BUCKETS: &[f64] = &[0.005, 0.01, 0.05, 0.1, 0.5, 1., 5., 10.];
/// Recommended default histogram buckets for internal process logic.
pub const PROCESS_HISTOGRAM_BUCKETS: &[f64] = &[
    0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1., 5., 10.,
];
/// Macro to prefix a string with the namespace.
macro_rules! namespaced {
    ($name:expr) => {
        format!("{NAMESPACE}_{}", $name)
    };
}

/// Metrics for a particular domain
pub struct CoreMetrics {
    /// Metrics registry for adding new metrics and gathering reports
    registry: Registry,
    const_labels: HashMap<String, String>,
    listen_port: Option<u16>,
    agent_name: String,

    span_durations: HistogramVec,
    span_events: IntCounterVec,
    last_known_message_leaf_index: IntGaugeVec,
    validator_checkpoint_index: IntGaugeVec,
    submitter_queue_length: IntGaugeVec,
    submitter_queue_duration_histogram: HistogramVec,

    messages_processed_count: IntCounterVec,

    outbox_state: IntGaugeVec,
    latest_checkpoint: IntGaugeVec,

    /// Set of provider-specific metrics. These only need to get created once.
    provider_metrics: OnceCell<MiddlewareMetrics>,
}

impl CoreMetrics {
    /// Track metrics for a particular agent name.
    ///
    /// - `for_agent` name of the agent these metrics are tracking.
    /// - `listen_port` port to start the HTTP server on. If None the server
    ///   will not be started.
    /// - `registry` prometheus registry to attach the metrics to
    pub fn new(
        for_agent: &str,
        listen_port: Option<u16>,
        registry: Registry,
    ) -> prometheus::Result<Self> {
        let const_labels: HashMap<String, String> = labels! {
            namespaced!("baselib_version") => env!("CARGO_PKG_VERSION").into(),
            "agent".into() => for_agent.into(),
        };
        let const_labels_ref = const_labels
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect::<HashMap<_, _>>();

        let span_durations = register_histogram_vec_with_registry!(
            histogram_opts!(
                namespaced!("span_duration_seconds"),
                "Duration from tracing span creation to span destruction",
                PROCESS_HISTOGRAM_BUCKETS.into(),
                const_labels.clone()
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

        let last_known_message_leaf_index = register_int_gauge_vec_with_registry!(
            opts!(
                namespaced!("last_known_message_leaf_index"),
                "Last known message leaf index",
                const_labels_ref
            ),
            &["phase", "origin", "remote"],
            registry
        )?;

        let validator_checkpoint_index = register_int_gauge_vec_with_registry!(
            opts!(
                namespaced!("validator_checkpoint_index"),
                "Observed signed checkpoint indices per validator",
                const_labels_ref
            ),
            &["origin", "validator"],
            registry
        )?;

        let submitter_queue_length = register_int_gauge_vec_with_registry!(
            opts!(
                namespaced!("submitter_queue_length"),
                "Submitter queue length",
                const_labels_ref
            ),
            &["origin", "remote", "queue_name"],
            registry
        )?;

        let submitter_queue_duration_histogram = register_histogram_vec_with_registry!(
            histogram_opts!(
                namespaced!("submitter_queue_duration_seconds"),
                concat!(
                    "Time a message spends queued in the serial submitter measured from ",
                    "insertion into channel from processor, ending after successful delivery ",
                    "to provider."
                ),
                prometheus::exponential_buckets(0.5, 2., 19).unwrap(),
                const_labels.clone()
            ),
            &["origin", "remote"],
            registry
        )?;

        let outbox_state = register_int_gauge_vec_with_registry!(
            opts!(
                namespaced!("outbox_state"),
                "Outbox contract state value",
                const_labels_ref
            ),
            &["chain"],
            registry
        )?;

        let latest_checkpoint = register_int_gauge_vec_with_registry!(
            opts!(
                namespaced!("latest_checkpoint"),
                "Outbox latest checkpoint",
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
            span_events,
            last_known_message_leaf_index,
            validator_checkpoint_index,

            submitter_queue_length,
            submitter_queue_duration_histogram,

            messages_processed_count,

            outbox_state,
            latest_checkpoint,

            provider_metrics: OnceCell::new(),
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

    /// Reports the current highest message leaf index at multiple phases of the
    /// relaying process. There may be messages that have not reached a certain
    /// stage, such as being fully processed, even if the reported index is
    /// higher than that message's index.
    ///
    /// Some phases are not able to report the remote chain, but origin chain is
    /// always reported.
    ///
    /// Labels:
    /// - `phase`: The phase the leaf index is being tracked at, see below.
    /// - `origin`: Origin chain the message comes from.
    /// - `remote`: Remote chain for the message. This will skip values because
    ///   the indexes are contiguous by origin not remote.
    ///
    /// The following phases are implemented:
    /// - `dispatch`: Highest leaf index which has been indexed on the outbox
    ///   contract syncer and stored in the relayer DB.
    /// - `signed_offchain_checkpoint`: Highest leaf index of a checkpoint which
    ///   is known to have been signed by a quorum of validators.
    /// - `processor_loop`: Highest leaf index which the MessageProcessor loop
    ///   has gotten to but not attempted to send it.
    /// - `message_processed`: When a leaf index was processed as part of the
    ///   MessageProcessor loop.
    pub fn last_known_message_leaf_index(&self) -> IntGaugeVec {
        self.last_known_message_leaf_index.clone()
    }

    /// Gauge for reporting the most recent validator checkpoint index
    /// Labels:
    /// - `origin`: Origin chain
    /// - `validator`: Address of the validator
    pub fn validator_checkpoint_index(&self) -> IntGaugeVec {
        self.validator_checkpoint_index.clone()
    }

    /// Gauge for reporting the current outbox state. This is either 0 (for
    /// UnInitialized), 1 (for Active), or 2 (for Failed). These are from the
    /// outbox contract States enum.
    ///
    /// Labels:
    /// - `chain`: The chain the outbox is for.
    pub fn outbox_state(&self) -> IntGaugeVec {
        self.outbox_state.clone()
    }

    /// Latest message leaf index in the validator.
    ///
    /// Phase:
    /// - `validator_observed`: When the validator has observed the checkpoint
    ///   on the outbox contract.
    /// - `validator_processed`: When the validator has written this checkpoint.
    pub fn latest_checkpoint(&self) -> IntGaugeVec {
        self.latest_checkpoint.clone()
    }

    /// Measure of the queue lengths in Submitter instances
    ///
    /// Labels:
    /// - `origin`: Origin chain the queue is for.
    /// - `remote`: Remote chain the queue is for.
    /// - `queue_name`: Which queue the message is in.
    pub fn submitter_queue_length(&self) -> IntGaugeVec {
        self.submitter_queue_length.clone()
    }

    /// Time a message spends queued in the serial submitter measured from
    /// the moment the message was discovered as "sendable" from AbacusDB and
    /// being enqueued and being enqueued with the relevant `submitter` ending
    /// on message processing success.
    ///
    /// Labels:
    /// - `origin`: Origin chain the messages are being sent from.
    /// - `remote`: Remote chain the messages are being sent to.
    pub fn submitter_queue_duration_histogram(&self) -> HistogramVec {
        self.submitter_queue_duration_histogram.clone()
    }

    /// The number of messages successfully submitted by this process during its
    /// lifetime.
    ///
    /// The value of
    /// `abacus_last_known_message_leaf_index{phase=message_processed}`
    /// should refer to the maximum leaf index value we ever successfully
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

    /// Histogram for measuring span durations provided by tracing.
    ///
    /// Labels:
    /// - `span_name`: name of the span. e.g. the function name.
    /// - `span_target`: a string that categorizes part of the system where the
    ///   span or event occurred. e.g. module path.
    pub fn span_duration(&self) -> HistogramVec {
        self.span_durations.clone()
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

    /// Run an HTTP server serving OpenMetrics format reports on `/metrics`
    ///
    /// This is compatible with Prometheus, which ought to be configured to
    /// scrape me!
    pub fn run_http_server(self: Arc<Self>) -> JoinHandle<()> {
        use warp::Filter;
        if let Some(port) = self.listen_port {
            tracing::info!(port, "starting prometheus server on 0.0.0.0:{port}");
            tokio::spawn(async move {
                warp::serve(
                    warp::path!("metrics")
                        .map(move || {
                            warp::reply::with_header(
                                self.gather().expect("failed to encode metrics"),
                                "Content-Type",
                                // OpenMetrics specs demands "application/openmetrics-text;
                                // version=1.0.0; charset=utf-8"
                                // but the prometheus scraper itself doesn't seem to care?
                                // try text/plain to make web browsers happy.
                                "text/plain; charset=utf-8",
                            )
                        })
                        .or(warp::any().map(|| {
                            warp::reply::with_status(
                                "go look at /metrics",
                                warp::http::StatusCode::NOT_FOUND,
                            )
                        })),
                )
                .run(([0, 0, 0, 0], port))
                .await;
            })
        } else {
            tracing::info!("not starting prometheus server");
            tokio::spawn(std::future::ready(()))
        }
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
