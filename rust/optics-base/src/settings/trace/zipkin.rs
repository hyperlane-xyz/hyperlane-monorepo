use std::convert::{TryFrom, TryInto};

use opentelemetry::{sdk::trace::Tracer, trace::TraceError};
use opentelemetry_zipkin::ZipkinPipelineBuilder;
use tracing::Subscriber;
use tracing_opentelemetry::OpenTelemetryLayer;
use tracing_subscriber::registry::LookupSpan;

/// Config parameters for Zipkin collector
#[derive(Debug, Clone, serde::Deserialize)]
pub struct ZipkinCollector {
    uri: String,
}

/// Config parameters for collection via Zipkin
#[derive(Debug, Clone, serde::Deserialize)]
pub struct ZipkinConfig {
    collector: ZipkinCollector,
    name: String,
}

impl From<&ZipkinConfig> for ZipkinPipelineBuilder {
    fn from(conf: &ZipkinConfig) -> Self {
        ZipkinPipelineBuilder::default()
            .with_service_name(&conf.name)
            .with_collector_endpoint(&conf.collector.uri)
    }
}

impl TryFrom<&ZipkinConfig> for Tracer {
    type Error = TraceError;

    fn try_from(value: &ZipkinConfig) -> Result<Self, Self::Error> {
        let p: ZipkinPipelineBuilder = value.into();
        p.install_batch(opentelemetry::runtime::Tokio)
    }
}

impl<S> TryFrom<&ZipkinConfig> for OpenTelemetryLayer<S, Tracer>
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    type Error = TraceError;

    fn try_from(value: &ZipkinConfig) -> Result<Self, Self::Error> {
        Ok(tracing_opentelemetry::layer().with_tracer(value.try_into()?))
    }
}
