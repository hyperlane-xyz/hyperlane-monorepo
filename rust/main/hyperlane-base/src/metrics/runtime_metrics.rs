use std::{fmt::Debug, time::Duration};

use eyre::Result;
use hyperlane_core::metrics::agent::METRICS_SCRAPE_INTERVAL;
use prometheus::{IntCounter, IntGauge};
use tokio::{task::JoinHandle, time::MissedTickBehavior};
use tokio_metrics::{TaskMetrics, TaskMonitor};
use tracing::{info_span, Instrument};

use super::CoreMetrics;

const RUNTIME_DROPPED_TASKS_HELP: &str = "The number of tasks dropped";
const RUNTIME_BLOCKING_THREADS_HELP: &str =
    "The number of Tokio blocking pool threads, including idle threads";
const RUNTIME_IDLE_BLOCKING_THREADS_HELP: &str = "The number of idle Tokio blocking pool threads";

/// Metrics for the runtime
pub struct RuntimeMetrics {
    producer: TaskMonitor,
    dropped_tasks: IntCounter,
    blocking_threads: IntGauge,
    idle_blocking_threads: IntGauge,
}

// Need this to be included in the agents structs
impl Debug for RuntimeMetrics {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RuntimeMetrics").finish()
    }
}

impl RuntimeMetrics {
    /// constructor
    pub fn new(metrics: &CoreMetrics, task_monitor: TaskMonitor) -> Result<RuntimeMetrics> {
        let dropped_tasks = metrics
            .new_int_counter("tokio_dropped_tasks", RUNTIME_DROPPED_TASKS_HELP, &[])?
            .with_label_values::<&str>(&[]);
        let blocking_threads = metrics
            .new_int_gauge("tokio_blocking_threads", RUNTIME_BLOCKING_THREADS_HELP, &[])?
            .with_label_values::<&str>(&[]);
        let idle_blocking_threads = metrics
            .new_int_gauge(
                "tokio_idle_blocking_threads",
                RUNTIME_IDLE_BLOCKING_THREADS_HELP,
                &[],
            )?
            .with_label_values::<&str>(&[]);
        let chain_metrics = Self {
            producer: task_monitor,
            dropped_tasks,
            blocking_threads,
            idle_blocking_threads,
        };
        Ok(chain_metrics)
    }

    fn update(&mut self, metrics: TaskMetrics) {
        self.dropped_tasks.inc_by(metrics.dropped_count);
        let runtime_metrics = tokio::runtime::Handle::current().metrics();
        self.blocking_threads
            .set(i64::try_from(runtime_metrics.num_blocking_threads()).unwrap_or(i64::MAX));
        self.idle_blocking_threads
            .set(i64::try_from(runtime_metrics.num_idle_blocking_threads()).unwrap_or(i64::MAX));
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

#[cfg(test)]
mod tests {
    use prometheus::Registry;
    use tokio::sync::oneshot;

    use super::*;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn updates_blocking_pool_thread_gauges() {
        let core_metrics = CoreMetrics::new("runtime-metrics-test", 0, Registry::new()).unwrap();
        let mut metrics = RuntimeMetrics::new(&core_metrics, TaskMonitor::new()).unwrap();
        let (started_tx, started_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();

        let blocking_task = tokio::task::spawn_blocking(move || {
            started_tx.send(()).unwrap();
            let _ = release_rx.blocking_recv();
        });
        started_rx.await.unwrap();

        let runtime_metrics = tokio::runtime::Handle::current().metrics();
        let blocking_threads = runtime_metrics.num_blocking_threads();
        let idle_blocking_threads = runtime_metrics.num_idle_blocking_threads();
        assert!(blocking_threads > idle_blocking_threads);

        metrics.update(TaskMetrics::default());

        assert_eq!(metrics.blocking_threads.get(), blocking_threads as i64);
        assert_eq!(
            metrics.idle_blocking_threads.get(),
            idle_blocking_threads as i64
        );

        release_tx.send(()).unwrap();
        blocking_task.await.unwrap();
    }
}
