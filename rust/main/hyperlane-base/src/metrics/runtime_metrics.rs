use std::{fmt::Debug, time::Duration};

use eyre::Result;
use hyperlane_core::metrics::agent::METRICS_SCRAPE_INTERVAL;
use prometheus::IntCounter;
use tokio::{task::JoinHandle, time::MissedTickBehavior};
use tokio_metrics::{TaskMetrics, TaskMonitor};
use tracing::{info_span, Instrument};

use super::CoreMetrics;

const RUNTIME_DROPPED_TASKS_HELP: &str = "The number of tasks dropped";

/// Metrics for the runtime
pub struct RuntimeMetrics {
    producer: TaskMonitor,
    dropped_tasks: IntCounter,
}

// Need this to be included in the agents structs
impl Debug for RuntimeMetrics {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RuntimeMetrics").finish()
    }
}

impl RuntimeMetrics {
    pub(crate) fn new(metrics: &CoreMetrics, task_monitor: TaskMonitor) -> Result<RuntimeMetrics> {
        let dropped_tasks = metrics
            .new_int_counter("tokio_dropped_tasks", RUNTIME_DROPPED_TASKS_HELP, &[])?
            .with_label_values(&[]);
        let chain_metrics = Self {
            producer: task_monitor,
            dropped_tasks,
        };
        Ok(chain_metrics)
    }

    fn update(&mut self, metrics: TaskMetrics) {
        self.dropped_tasks.inc_by(metrics.dropped_count);
    }

    /// Periodically updates the metrics
    pub async fn start_updating_on_interval(mut self, period: Duration) {
        let mut interval = tokio::time::interval(period);
        interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
        let mut metric_intervals = self.producer.intervals();
        loop {
            if let Some(metrics) = metric_intervals.next() {
                self.update(metrics);
            }
            interval.tick().await;
        }
    }

    /// Spawns a tokio task to update the metrics
    pub fn spawn(self) -> JoinHandle<()> {
        tokio::task::Builder::new()
            .name("metrics::runtime")
            .spawn(
                async move {
                    self.start_updating_on_interval(METRICS_SCRAPE_INTERVAL)
                        .await;
                }
                .instrument(info_span!("RuntimeMetricsUpdater")),
            )
            .expect("spawning tokio task from Builder is infallible")
    }
}
