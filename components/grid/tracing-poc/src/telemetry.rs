//! OpenTelemetry + tracing subscriber initialisation.
//!
//! Sets up a [`tracing`] subscriber with two layers:
//! - a `fmt` layer for human-readable log output;
//! - an `OpenTelemetryLayer` that bridges `tracing` spans to OpenTelemetry and exports them via OTLP HTTP.

use opentelemetry::trace::TracerProvider as _;
use opentelemetry_otlp::WithExportConfig as _;
use opentelemetry_sdk::trace::SdkTracerProvider;
use tracing_subscriber::{layer::SubscriberExt as _, util::SubscriberInitExt as _};

use crate::error::PocError;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Initialise the OpenTelemetry tracer provider and the global
/// [`tracing`] subscriber.
///
/// Returns the [`SdkTracerProvider`] so the caller can keep it alive
/// for the duration of the program. Dropping it triggers a flush.
///
/// # Errors
///
/// Returns [`PocError::Telemetry`] if the OTLP exporter or the
/// subscriber cannot be created.
pub(crate) fn init(otlp_endpoint: &str) -> Result<SdkTracerProvider, PocError> {
    // Set the global propagator to W3C TraceContext.
    opentelemetry::global::set_text_map_propagator(opentelemetry_sdk::propagation::TraceContextPropagator::new());

    // Build the OTLP span exporter.
    let exporter = opentelemetry_otlp::SpanExporter::builder()
        .with_http()
        .with_endpoint(format!("{otlp_endpoint}/v1/traces"))
        .build()
        .map_err(|e| PocError::Telemetry(format!("otlp exporter: {e}")))?;

    // Build the tracer provider with a batch span processor.
    let provider = SdkTracerProvider::builder()
        .with_batch_exporter(exporter)
        .with_resource(
            opentelemetry_sdk::Resource::builder()
                .with_service_name("grid-tracing-poc")
                .build(),
        )
        .build();

    // Create a tracer from the provider.
    let tracer = provider.tracer("grid-tracing-poc");

    // Build the tracing subscriber: fmt layer + OTel layer.
    let otel_layer = tracing_opentelemetry::layer().with_tracer(tracer);
    let fmt_layer = tracing_subscriber::fmt::layer().with_target(false).compact();
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));

    tracing_subscriber::registry()
        .with(filter)
        .with(fmt_layer)
        .with(otel_layer)
        .init();

    Ok(provider)
}

/// Flush pending spans to the collector.
///
/// Calls `force_flush` on the provider so in-flight spans are
/// exported before querying Jaeger.
pub(crate) fn flush(provider: &SdkTracerProvider) {
    if let Err(e) = provider.force_flush() {
        tracing::warn!("span flush failed: {e}");
    }
}
