use eyre::Result;
pub use span_metrics::TimeSpanLifetime;
use tracing_subscriber::{
    filter::{LevelFilter, Targets},
    prelude::*,
};

use self::fmt::LogOutputLayer;
use crate::{settings::trace::fmt::Style, CoreMetrics};

/// Configure a `tracing_subscriber::fmt` Layer outputting to stdout
pub mod fmt;

mod span_metrics;

#[cfg(test)]
mod credential_tests;

/// Logging level. A "higher level" means more will be logged.
#[derive(Default, Debug, Clone, Copy, serde::Deserialize, PartialOrd, Ord, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Level {
    /// Off
    Off = 0,
    /// Error
    Error = 1,
    /// Warn
    Warn = 2,
    /// Debug
    Debug = 4,
    /// Trace
    Trace = 5,
    /// Trace + Additional logs from dependencies
    DependencyTrace = 6,
    /// Info
    #[serde(other)]
    #[default]
    Info = 3,
}

impl From<Level> for LevelFilter {
    fn from(level: Level) -> LevelFilter {
        match level {
            Level::Off => LevelFilter::OFF,
            Level::Error => LevelFilter::ERROR,
            Level::Warn => LevelFilter::WARN,
            Level::Debug => LevelFilter::DEBUG,
            Level::Trace | Level::DependencyTrace => LevelFilter::TRACE,
            Level::Info => LevelFilter::INFO,
        }
    }
}

/// Configuration for the tracing subscribers used by Hyperlane agents
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct TracingConfig {
    #[serde(default)]
    pub(crate) fmt: Style,
    #[serde(default)]
    pub(crate) level: Level,
}

impl TracingConfig {
    /// Attempt to instantiate and register a tracing subscriber setup from
    /// settings.
    pub fn start_tracing(&self, metrics: &CoreMetrics) -> Result<console_subscriber::Server> {
        let target_layer = self.targets();
        let fmt_layer: LogOutputLayer<_> = self.fmt.into();
        let err_layer = tracing_error::ErrorLayer::default();

        let (tokio_layer, tokio_server) = console_subscriber::ConsoleLayer::new();
        let subscriber = tracing_subscriber::Registry::default()
            .with(tokio_layer)
            .with(target_layer)
            .with(TimeSpanLifetime::new(metrics))
            .with(fmt_layer)
            .with(err_layer);

        subscriber.try_init()?;
        Ok(tokio_server)
    }

    fn targets(&self) -> Targets {
        let mut target_layer = Targets::new().with_default(self.level);

        if self.level < Level::DependencyTrace {
            // Reduce log noise from trusted libraries that we can reasonably assume are working correctly
            target_layer = target_layer
                .with_target("cometbft", Level::Warn)
                .with_target("rustls", Level::Info)
                .with_target("runtime", Level::Debug)
                .with_target("tower", Level::Info)
                .with_target("tendermint", Level::Info)
                .with_target("tokio", Level::Debug)
                // Enable Trace level for Tokio if you want to use tokio-console
                // .with_target("tokio", Level::Trace)
                .with_target("ethers_providers", Level::Debug);
        }

        if self.level < Level::Trace {
            // only show sqlx query logs at trace level
            target_layer = target_layer.with_target("sqlx::query", Level::Warn);
        }
        // These dependencies log authentication headers, tokens, cookies, or
        // RPC URLs or database connection options. Never enable these diagnostics,
        // even in dependencyTrace mode, or raise a quieter configured level.
        for target in [
            "yup_oauth2",
            "rusoto_core",
            "rusoto_signature",
            "aws_sigv4",
            "aws_smithy_runtime",
            "aws_smithy_runtime_api",
            "aws_sdk_s3",
            "cookie_store",
            "tungstenite",
            "reqwest",
            "hyper",
            "hyper_util",
            "h2",
            "solana_rpc_client",
            "cometbft_rpc",
            "tendermint_rpc",
            "sea_orm::driver::sqlx_postgres",
        ] {
            target_layer = target_layer.with_target(target, self.level.min(Level::Info));
        }
        // SQLx warns with raw values for unrecognized database URL parameters.
        target_layer.with_target(
            "sqlx_postgres::options::parse",
            LevelFilter::from(self.level).min(LevelFilter::ERROR),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_sensitive_logs_stay_capped_at_every_level() {
        for level in [
            Level::Off,
            Level::Error,
            Level::Warn,
            Level::Info,
            Level::Debug,
            Level::Trace,
            Level::DependencyTrace,
        ] {
            let targets = TracingConfig {
                level,
                ..Default::default()
            }
            .targets();
            for target in [
                "yup_oauth2::authenticator",
                "rusoto_core::request",
                "rusoto_signature::signature",
                "aws_sigv4::http_request::sign",
                "aws_smithy_runtime::client::orchestrator",
                "aws_smithy_runtime_api::client",
                "aws_sdk_s3::operation",
                "cookie_store::cookie_store",
                "tungstenite::handshake::client",
                "tungstenite::client",
                "reqwest::async_impl::client",
                "hyper::proto::h1",
                "hyper_util::client",
                "h2::hpack::encoder",
                "solana_rpc_client::http_sender",
                "cometbft_rpc::client::transport::http",
                "tendermint_rpc::client::transport::http",
                "sea_orm::driver::sqlx_postgres",
            ] {
                assert!(!targets.would_enable(target, &tracing::Level::DEBUG));
                assert!(!targets.would_enable(target, &tracing::Level::TRACE));
                assert_eq!(
                    targets.would_enable(target, &tracing::Level::INFO),
                    level >= Level::Info
                );
                assert_eq!(
                    targets.would_enable(target, &tracing::Level::ERROR),
                    level >= Level::Error
                );
            }
            assert!(!targets.would_enable("sqlx_postgres::options::parse", &tracing::Level::WARN));
            assert_eq!(
                targets.would_enable("validator", &tracing::Level::DEBUG),
                level >= Level::Debug
            );
        }
    }
}
