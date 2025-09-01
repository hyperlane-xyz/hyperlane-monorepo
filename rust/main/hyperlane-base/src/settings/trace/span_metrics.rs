use crate::CoreMetrics;
use tokio::time::Instant;
use tracing::{span, Event, Level, Subscriber};
use tracing_subscriber::{layer::Context, registry::LookupSpan, Layer};

/// Records span lifetime into a prometheus histogram.
pub struct TimeSpanLifetime {
    duration: prometheus::CounterVec,
    count: prometheus::IntCounterVec,
    events: prometheus::IntCounterVec,
}

impl TimeSpanLifetime {
    /// Constructor.
    pub fn new(metrics: &CoreMetrics) -> Self {
        Self {
            duration: metrics.span_duration_seconds(),
            count: metrics.span_count(),
            events: metrics.span_events(),
        }
    }
}

struct SpanTiming {
    start: Instant,
}

impl<S> Layer<S> for TimeSpanLifetime
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_new_span(&self, _: &span::Attributes<'_>, id: &span::Id, ctx: Context<'_, S>) {
        let Some(span) = ctx.span(id) else {
            unreachable!()
        };
        span.extensions_mut().insert(SpanTiming {
            start: Instant::now(),
        });
    }

    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let level = match *event.metadata().level() {
            Level::TRACE => "trace",
            Level::DEBUG => "debug",
            Level::INFO => "info",
            Level::WARN => "warn",
            Level::ERROR => "error",
        };
        self.events.with_label_values(&[level]).inc();
    }

    fn on_close(&self, id: span::Id, ctx: Context<S>) {
        let now = Instant::now();
        let Some(span) = ctx.span(&id) else {
            unreachable!()
        };

        let exts = span.extensions();
        let timing = exts
            .get::<SpanTiming>()
            .expect("bug: didn't insert SpanTiming");
        let tags = [span.name(), span.metadata().target()];
        self.count.with_label_values(&tags).inc();

        let diff = now.saturating_duration_since(timing.start).as_secs_f64();
        self.duration.with_label_values(&tags).inc_by(diff);
    }
}
