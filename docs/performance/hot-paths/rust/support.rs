use std::{
    fs::OpenOptions,
    io::Write,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

#[derive(Debug, Default)]
pub struct Activity {
    pub started: AtomicUsize,
    pub active: AtomicUsize,
    pub peak: AtomicUsize,
}

pub struct Active(Arc<Activity>);

impl Activity {
    pub fn enter(self: &Arc<Self>) -> Active {
        self.started.fetch_add(1, Ordering::Relaxed);
        let active = self
            .active
            .fetch_add(1, Ordering::Relaxed)
            .saturating_add(1);
        self.peak.fetch_max(active, Ordering::Relaxed);
        Active(self.clone())
    }
}

impl Drop for Active {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::Relaxed);
    }
}

#[derive(Clone, Copy, Debug)]
pub enum Version {
    Before,
    After,
}

impl Version {
    pub fn label(self) -> &'static str {
        match self {
            Self::Before => "before",
            Self::After => "after",
        }
    }
}

pub fn parameter(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .map(|value| value.parse().expect("numeric benchmark parameter"))
        .unwrap_or(default)
}

pub fn order(iteration: usize) -> [Version; 2] {
    if iteration % 2 == 0 {
        [Version::Before, Version::After]
    } else {
        [Version::After, Version::Before]
    }
}

pub async fn delay(milliseconds: u64) {
    if milliseconds > 0 {
        tokio::time::sleep(Duration::from_millis(milliseconds)).await;
    }
}

pub fn record(
    case: &str,
    scenario: &str,
    version: Version,
    iteration: usize,
    warmup: bool,
    elapsed: Duration,
    items: usize,
    activity: &Activity,
) {
    assert_eq!(activity.active.load(Ordering::Relaxed), 0);
    let sample = serde_json::json!({
        "case": case,
        "scenario": scenario,
        "version": version.label(),
        "iteration": iteration,
        "warmup": warmup,
        "elapsed_ns": elapsed.as_nanos(),
        "items": items,
        "requests": activity.started.load(Ordering::Relaxed),
        "peak_concurrency": activity.peak.load(Ordering::Relaxed),
        "active_after": activity.active.load(Ordering::Relaxed),
    });
    let path = std::env::var("HOTPATH_SAMPLES").expect("sample output path");
    let mut output = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .expect("open sample output");
    serde_json::to_writer(&mut output, &sample).expect("write sample");
    writeln!(output).expect("sample newline");
}
