use eyre::Result;
pub use span_metrics::TimeSpanLifetime;
use tracing_subscriber::{
    filter::{LevelFilter, Targets},
    prelude::*,
};

use self::fmt::LogOutputLayer;
use crate::{settings::trace::fmt::Style, CoreMetrics};

use opentelemetry::{global, trace::TracerProvider as _, KeyValue};
use opentelemetry_sdk::{
    runtime,
    trace::{BatchConfig, Config, RandomIdGenerator, Sampler, Tracer, TracerProvider},
    Resource,
};
use opentelemetry_semantic_conventions::{
    resource::{DEPLOYMENT_ENVIRONMENT, SERVICE_NAME, SERVICE_VERSION},
    SCHEMA_URL,
};
// use tracing_core::Level;
use opentelemetry_sdk::propagation::TraceContextPropagator;
use opentelemetry_sdk::runtime::Tokio;
use tracing_opentelemetry::{OpenTelemetryLayer};
use tracing_stackdriver::{CloudTraceConfiguration};
use tracing_subscriber::{
    layer::{SubscriberExt},
    util::SubscriberInitExt,
};


/// Configure a `tracing_subscriber::fmt` Layer outputting to stdout
pub mod fmt;

mod span_metrics;

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
    // Create a Resource that captures information about the entity for which telemetry is recorded.
    fn resource() -> Resource {
        Resource::from_schema_url(
            [
                KeyValue::new(SERVICE_NAME, env!("CARGO_PKG_NAME")),
                KeyValue::new(SERVICE_VERSION, env!("CARGO_PKG_VERSION")),
                KeyValue::new(DEPLOYMENT_ENVIRONMENT, "develop"),
            ],
            SCHEMA_URL,
        )
    }

    // Construct Tracer for OpenTelemetryLayer
    fn init_tracer() -> Tracer {
        opentelemetry_otlp::new_pipeline()
            .tracing()
            .with_trace_config(
                opentelemetry_sdk::trace::Config::default()
                    // Customize sampling strategy
                    .with_sampler(Sampler::ParentBased(Box::new(Sampler::TraceIdRatioBased(
                        1.0,
                    ))))
                    // If export trace to AWS X-Ray, you can use XrayIdGenerator
                    .with_id_generator(RandomIdGenerator::default())
                    .with_resource(Self::resource()),
            )
            .with_batch_config(BatchConfig::default())
            .with_exporter(opentelemetry_otlp::new_exporter().tonic())
            .install_batch(runtime::Tokio)
            .unwrap()
    }

    // pub(crate) async fn initialize_tracing_subscriber() {
    //     //this is the layer that used to be jaeger, now it's Stackdriver
    //     //it exports the traces/spans to GCP
    //     let otel_layer = Self::construct_open_telemetry_layer().await;

    //     // used to export logs in gcp compatible format
    //     // make sure to replace with your own project id
    //     let stackdriver_layer =
    //         tracing_stackdriver::layer().with_cloud_trace(CloudTraceConfiguration {
    //             project_id: "abacus-labs-dev".to_string(),
    //         });

    //     let subscriber = Registry::default()
    //         .with(EnvFilter::from_default_env())
    //         .with(otel_layer)
    //         .with(stackdriver_layer);

    //     tracing::subscriber::set_global_default(subscriber)
    //         .expect("Could not set up global logger");
    // }

    //the entire body of this function has changed
    //
    //we are now exporting traces to GCP Trace Explorer
    //instead of Jaeger
    async fn construct_open_telemetry_layer() -> Tracer {
        // ) -> OpenTelemetryLayer<Layered<EnvFilter, Registry, Registry>, opentelemetry_sdk::trace::Tracer> {
        //when running inside gcp we don't need authentication
        let authorizer = opentelemetry_stackdriver::GcpAuthorizer::new()
            .await
            .expect("Failed to create GCP authorizer.");

        //the tracer is the same trait we had with jaeger exporting
        //
        //driver is the future that we need to run that will export
        //all the trace batches in the background
        let (stackdriver_tracer, driver) = opentelemetry_stackdriver::Builder::default()
            .build(authorizer)
            .await
            .expect("Failed to create Stackdriver tracer.");

        //we need to explicitly spawn the fiber that will export batches of traces to GCP
        //
        //internally it blocks on the channel receiver so the fiber will complete
        //when the sender is dropped but we should still join the returned handle
        //on shutdown
        //we're skipping that here to reduce the boilerplate code
        tokio::spawn(driver);

        let provider = TracerProvider::builder()
            .with_batch_exporter(stackdriver_tracer, Tokio)
            .with_config(Config {
                //we're using ParentBased sampling, which means that
                //we'll respect whatever whoever called us decided
                //when it comes to sampling a specific request
                //
                //in case there is no decision by the parent span, we're sampling
                //with ratio 1.0 (100%) so we're recording all the requests
                sampler: Box::new(Sampler::ParentBased(Box::new(Sampler::TraceIdRatioBased(
                    1.0,
                )))),
                ..Default::default()
            })
            .with_span_processor(CustomSpanProcessor::new())
            .build();

        let tracer = provider.tracer("Example application");

        //install the tracer provider globally (this was done under the hood for us when we were using jaeger)
        // global::set_tracer_provider(provider);

        //use W3 standard for context propagation in open telemetry
        global::set_text_map_propagator(TraceContextPropagator::new());

        // OpenTelemetryLayer::new(tracer)
        tracer
    }

    /// Attempt to instantiate and register a tracing subscriber setup from
    /// settings.
    pub async fn start_tracing(&self, metrics: &CoreMetrics) -> Result<console_subscriber::Server> {
        let mut target_layer = Targets::new().with_default(self.level);

        if self.level < Level::DependencyTrace {
            // Reduce log noise from trusted libraries that we can reasonably assume are working correctly
            target_layer = target_layer
                .with_target("hyper::", Level::Info)
                .with_target("rusoto_core", Level::Info)
                .with_target("rustls", Level::Info)
                .with_target("reqwest", Level::Info)
                .with_target("runtime", Level::Debug)
                .with_target("h2::", Level::Info)
                .with_target("tower", Level::Info)
                .with_target("tendermint", Level::Info)
                .with_target("tokio", Level::Debug)
                .with_target("tokio_util", Level::Debug)
                .with_target("ethers_providers", Level::Debug);
        }

        if self.level < Level::Trace {
            // only show sqlx query logs at trace level
            target_layer = target_layer
                .with_target("sqlx::query", Level::Warn)
                .with_target("hyper::", Level::Warn);
        }
        let fmt_layer: LogOutputLayer<_> = self.fmt.into();
        let err_layer = tracing_error::ErrorLayer::default();

        let otel_layer = Self::construct_open_telemetry_layer().await;

        // used to export logs in gcp compatible format
        // make sure to replace with your own project id
        // let stackdriver_layer: Layer<Layered<OpenTelemetryLayer<Layered<EnvFilter, Registry>, Tracer>, Layered<EnvFilter, Registry>>> =
        let stackdriver_layer =
            tracing_stackdriver::layer().with_cloud_trace(CloudTraceConfiguration {
                project_id: "abacus-labs-dev".to_string(),
            });

        let (tokio_layer, tokio_server) = console_subscriber::ConsoleLayer::new();
        let subscriber = tracing_subscriber::Registry::default()
            .with(tokio_layer)
            .with(target_layer)
            .with(TimeSpanLifetime::new(metrics))
            .with(fmt_layer)
            .with(err_layer)
            .with(OpenTelemetryLayer::new(otel_layer))
            .with(stackdriver_layer);
        // .with(otel_layer);
        // .with(stackdriver_layer);

        // .with(OpenTelemetryLayer::new(Self::init_tracer()));

        subscriber.try_init()?;
        Ok(tokio_server)
    }
}

use opentelemetry::trace::{Span as _, TraceResult};
use opentelemetry::Context;
use opentelemetry_sdk::export::trace::SpanData;
use opentelemetry_sdk::trace::{Span, SpanProcessor};
use std::fmt::Debug;

#[derive(Debug)]
pub struct CustomSpanProcessor {}

impl CustomSpanProcessor {
    pub fn new() -> Self {
        CustomSpanProcessor {}
    }
}

const GCP_SERVICE_NAME_ATTRIBUTE: &str = "service.name";

const INTEGRATION_ENGINE_SERVICE_NAME: &str = "TrevorsPlayground";

impl SpanProcessor for CustomSpanProcessor {
    fn on_start(&self, span: &mut Span, _cx: &Context) {
        span.set_attribute(KeyValue::new(
            GCP_SERVICE_NAME_ATTRIBUTE,
            INTEGRATION_ENGINE_SERVICE_NAME,
        ));
    }

    fn on_end(&self, _span: SpanData) {}

    fn force_flush(&self) -> TraceResult<()> {
        Ok(())
    }

    fn shutdown(&mut self) -> TraceResult<()> {
        Ok(())
    }
}
