use std::collections::HashMap;
use std::fmt::{Debug, Formatter};
use std::sync::Arc;
use std::time::Duration;

use eyre::Result;
use prometheus::{
    Encoder, histogram_opts, HistogramVec, IntCounterVec,
    IntGaugeVec, labels, opts,
    register_histogram_vec_with_registry, register_int_counter_vec_with_registry, register_int_gauge_vec_with_registry, Registry,
};
use tokio::task::JoinHandle;
use abacus_core::Address;

use super::NAMESPACE;

const NETWORK_HISTOGRAM_BUCKETS: &[f64] = &[0.005, 0.01, 0.05, 0.1, 0.5, 1., 5., 10.];
const PROCESS_HISTOGRAM_BUCKETS: &[f64] = &[
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

    transactions: IntCounterVec,
    wallet_balance: IntGaugeVec,
    rpc_latencies: HistogramVec,
    span_durations: HistogramVec,
    span_events: IntCounterVec,
    last_known_message_leaf_index: IntGaugeVec,
    retry_queue_length: IntGaugeVec,
}

impl CoreMetrics {
    /// Track metrics for a particular agent name.
    ///
    /// - `for_agent` name of the agent these metrics are tracking.
    /// - `listen_port` port to start the HTTP server on. If None the server will not be started.
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

        /// - `address_from` is the source address/wallet
        /// - `address_to` is the destination address/wallet
        /// - `txn_status` is one of `dispatched`, `completed`, or `failed`.
        /// - `chain` is the chain name (or ID if the name is unknown) of the chain the txn occured on
        let transactions = register_int_counter_vec_with_registry!(
            opts!(
                namespaced!("transactions_total"),
                "Number of transactions sent by this agent since boot",
                const_labels_ref
            ),
            &["txn_status", "chain", "address_from", "address_to"],
            registry
        )?;

        let wallet_balance = register_int_gauge_vec_with_registry!(
            opts!(
                namespaced!("wallet_balance_total"),
                "Balance of the smart contract wallet",
                const_labels_ref
            ),
            &["chain", "wallet"],
            registry
        )?;

        let rpc_latencies = register_histogram_vec_with_registry!(
            histogram_opts!(
                namespaced!("rpc_duration_seconds"),
                "Duration from dispatch to receipt-of-response for RPC calls",
                NETWORK_HISTOGRAM_BUCKETS.into(),
                const_labels.clone()
            ),
            &["chain", "method"],
            registry
        )?;

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

        // Tracking the number of events emitted helps us verify logs are not being dropped and
        // provides a quick way to query error and warning counts.
        let span_events = register_int_counter_vec_with_registry!(
            opts!(
                namespaced!("span_events_total"),
                "Number of span events (logs and time metrics) emitted by level",
                const_labels_ref
            ),
            &["event_level"],
            registry
        )?;

        // "remote is unknown where remote is unavailable"
        // The following phases are implemented:
        // - dispatch: When a message is indexed and stored in the DB
        // - signed_offchain_checkpoint: When a leaf index is known to be signed by a validator
        // - inbox_checkpoint: When a leaf index is known to be checkpointed on the inbox
        // - relayer_processed: When a leaf index was processed with CheckpointRelayer
        // - processor_loop: The current leaf index in the MessageProcessor loop
        // - message_processed: When a leaf index was processed as part of the regular MessageProcessor loop
        let last_known_message_leaf_index = register_int_gauge_vec_with_registry!(
            opts!(
                namespaced!("last_known_message_leaf_index"),
                "Last known message leaf index",
                const_labels_ref
            ),
            &["phase", "origin", "remote"],
            registry
        )?;

        let retry_queue_length = register_int_gauge_vec_with_registry!(
            opts!(
                namespaced!("processor_retry_queue"),
                "Retry queue length of MessageProcessor",
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

            transactions,
            wallet_balance,
            rpc_latencies,
            span_durations,
            span_events,
            last_known_message_leaf_index,
            retry_queue_length,
        })
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

    pub fn transaction_dispatched(&self, chain: &str, from: Address, to: Address) {
        self.transactions
            .with_label_values(&[
                "dispatched",
                chain,
                &format!("{address:x}"),
                &self.agent_name,
            ])
            .inc()
    }

    pub fn transaction_completed(&self, chain: &str, from: Address, to: Address) {
        self.transactions
            .with_label_values(&[
                "completed",
                chain,
                &format!("{address:x}"),
                &self.agent_name,
            ])
            .inc()
    }

    pub fn transaction_failed(&self, chain: &str, address: ethers::types::Address) {
        self.transactions
            .with_label_values(&["failed", chain, &format!("{address:x}"), &self.agent_name])
            .inc()
    }

    /// Call with the new balance when gas is spent.
    pub fn wallet_balance_changed(
        &self,
        chain: &str,
        address: ethers::types::Address,
        current_balance: ethers::types::U256,
    ) {
        self.wallet_balance
            .with_label_values(&[chain, &format!("{address:x}"), &self.agent_name])
            .set(current_balance.as_u64() as i64) // XXX: truncated data
    }

    /// Call with RPC duration after it is complete
    pub fn rpc_complete(&self, chain: &str, method: &str, duration: Duration) {
        self.rpc_latencies
            .with_label_values(&[chain, method, &self.agent_name])
            .observe(duration.as_secs_f64())
    }

    /// Gauge for measuring the last known message leaf index
    pub fn last_known_message_leaf_index(&self) -> IntGaugeVec {
        self.last_known_message_leaf_index.clone()
    }

    /// Gauge for measuring the retry queue length in MessageProcessor
    pub fn retry_queue_length(&self) -> IntGaugeVec {
        self.retry_queue_length.clone()
    }

    /// Histogram for measuring span durations.
    ///
    /// Labels needed:
    /// - `span_name`: name of the span. e.g. the function name.
    /// - `span_target`: a string that categorizes part of the system where the span or event occurred. e.g. module path.
    pub fn span_duration(&self) -> HistogramVec {
        self.span_durations.clone()
    }

    /// Counts of span events.
    ///
    /// Labels needed:
    /// - `event_level`: level of the event, i.e. trace, debug, info, warn, error.
    ///
    pub fn span_events(&self) -> IntCounterVec {
        self.span_events.clone()
    }

    /// Gather available metrics into an encoded (plaintext, OpenMetrics format) report.
    pub fn gather(&self) -> prometheus::Result<Vec<u8>> {
        let collected_metrics = self.registry.gather();
        let mut out_buf = Vec::with_capacity(1024 * 64);
        let encoder = prometheus::TextEncoder::new();
        encoder.encode(&collected_metrics, &mut out_buf)?;
        Ok(out_buf)
    }

    /// Run an HTTP server serving OpenMetrics format reports on `/metrics`
    ///
    /// This is compatible with Prometheus, which ought to be configured to scrape me!
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
                                // OpenMetrics specs demands "application/openmetrics-text; version=1.0.0; charset=utf-8"
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
