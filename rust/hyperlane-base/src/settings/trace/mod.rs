use eyre::Result;
use tracing_opentelemetry::OpenTelemetryLayer;
use tracing_subscriber::{
    filter::{LevelFilter, Targets},
    prelude::*,
};

pub use span_metrics::TimeSpanLifetime;

use crate::settings::trace::fmt::Style;
use crate::CoreMetrics;

use self::{fmt::LogOutputLayer, jaeger::JaegerConfig, zipkin::ZipkinConfig};

/// Configure a `tracing_subscriber::fmt` Layer outputting to stdout
pub mod fmt;

/// Configure a Layer using `tracing_opentelemtry` + `opentelemetry-jaeger`
pub mod jaeger;

/// Configure a Layer using `tracing_opentelemtry` + `opentelemetry-zipkin`
pub mod zipkin;

mod span_metrics;

/// Logging level. A "higher level" means more will be logged.
#[derive(Debug, Clone, Copy, serde::Deserialize, PartialOrd, Ord, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Level {
    /// Off
    Off = 0,
    /// Error
    Error = 1,
    /// Warn
    Warn = 2,
    /// Debug
    Debug = 3,
    /// Trace
    Trace = 5,
    /// Info
    #[serde(other)]
    Info = 4,
}

impl Default for Level {
    fn default() -> Self {
        Level::Info
    }
}

impl From<Level> for LevelFilter {
    fn from(level: Level) -> LevelFilter {
        match level {
            Level::Off => LevelFilter::OFF,
            Level::Error => LevelFilter::ERROR,
            Level::Warn => LevelFilter::WARN,
            Level::Debug => LevelFilter::DEBUG,
            Level::Trace => LevelFilter::TRACE,
            Level::Info => LevelFilter::INFO,
        }
    }
}

/// Configuration for the tracing subscribers used by Hyperlane agents
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct TracingConfig {
    jaeger: Option<JaegerConfig>,
    zipkin: Option<ZipkinConfig>,
    #[serde(default)]
    fmt: Style,
    #[serde(default)]
    level: Level,
}

impl TracingConfig {
    /// Attempt to instantiate and register a tracing subscriber setup from
    /// settings.
    pub fn start_tracing(&self, metrics: &CoreMetrics) -> Result<()> {
        let mut target_layer = Targets::new().with_default(self.level);
        if self.level < Level::Trace {
            // only show hyper debug and trace logs at trace level
            target_layer = target_layer.with_target("hyper", Level::Info);
            target_layer = target_layer.with_target("rusoto_core", Level::Info);
            target_layer = target_layer.with_target("reqwest", Level::Info);
        }
        let fmt_layer: LogOutputLayer<_> = self.fmt.into();
        let err_layer = tracing_error::ErrorLayer::default();

        let subscriber = tracing_subscriber::Registry::default()
            .with(target_layer)
            .with(TimeSpanLifetime::new(metrics))
            .with(fmt_layer)
            .with(err_layer);

        if let Some(jaeger) = &self.jaeger {
            let layer: OpenTelemetryLayer<_, _> = jaeger.try_into_layer()?;
            subscriber.with(layer).try_init()?;
            return Ok(());
        }
        if let Some(zipkin) = &self.zipkin {
            let layer: OpenTelemetryLayer<_, _> = zipkin.try_into_layer()?;
            subscriber.with(layer).try_init()?;
            return Ok(());
        }
        subscriber.try_init()?;
        Ok(())
    }
}
