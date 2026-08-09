//! Reusable web-framework tracing layer for AI Grid gateways.
//!
//! Provides W3C trace-context propagation, SERVER/CLIENT span
//! creation, and routing event recording. Feature-gated behind
//! the `otel` feature flag — when disabled, all public functions
//! compile as lightweight no-ops.
//!
//! # Feature flags
//!
//! - **`otel`** — Enables OpenTelemetry integration (propagation,
//!   OTLP export, span context). Without this feature, span
//!   helpers still create `tracing` spans but without `OTel`
//!   parent-context linkage.
//!
//! # Adapter note
//!
//! This layer targets Axum/Hyper (Tower-based) HTTP frameworks.
//! Real Praxis AI uses Pingora via external crates; integrating
//! there requires adapting these helpers to the Pingora filter
//! pipeline (`HttpFilter` trait from `praxis-filter`).

mod extract;
mod routing;
mod spans;

pub use extract::{extract_parent_context, inject_trace_context};
pub use routing::{RoutingEvent, record_routing_event};
pub use spans::{client_span, server_span};

/// Initialize the W3C [`TraceContext`] propagator globally.
///
/// Call once at startup before any span extraction or injection.
/// When the `otel` feature is disabled this is a no-op.
///
/// [`TraceContext`]: https://www.w3.org/TR/trace-context/
pub fn init_propagator() {
    #[cfg(feature = "otel")]
    {
        opentelemetry::global::set_text_map_propagator(opentelemetry_sdk::propagation::TraceContextPropagator::new());
    }
}
