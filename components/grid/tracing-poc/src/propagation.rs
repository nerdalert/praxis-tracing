//! W3C trace-context propagation helpers.
//!
//! Provides [`extract_context`] and [`inject_context`] to carry
//! `traceparent` headers across HTTP boundaries using the
//! OpenTelemetry [`TextMapPropagator`] API.
//!
//! [`TextMapPropagator`]: opentelemetry::propagation::TextMapPropagator

use std::collections::HashMap;

use opentelemetry::{
    Context,
    propagation::{Extractor, Injector},
};

// ---------------------------------------------------------------------------
// Header adapters
// ---------------------------------------------------------------------------

/// Adapter that lets OpenTelemetry read from an [`http::HeaderMap`].
struct HeaderExtractor<'a> {
    /// Borrowed header map to read from.
    headers: &'a http::HeaderMap,
}

impl Extractor for HeaderExtractor<'_> {
    fn get(&self, key: &str) -> Option<&str> {
        self.headers.get(key).and_then(|v| v.to_str().ok())
    }

    fn keys(&self) -> Vec<&str> {
        self.headers.keys().map(http::HeaderName::as_str).collect()
    }
}

/// Adapter that lets OpenTelemetry write into a [`HashMap`].
struct MapInjector<'a> {
    /// Mutable map to write into.
    map: &'a mut HashMap<String, String>,
}

impl Injector for MapInjector<'_> {
    fn set(&mut self, key: &str, value: String) {
        self.map.insert(key.to_owned(), value);
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Extract an OpenTelemetry [`Context`] from incoming HTTP headers.
///
/// Reads the `traceparent` (and optional `tracestate`) header values
/// and reconstructs the parent span context.
pub(crate) fn extract_context(headers: &http::HeaderMap) -> Context {
    let extractor = HeaderExtractor { headers };
    opentelemetry::global::get_text_map_propagator(|propagator| propagator.extract(&extractor))
}

/// Inject the current trace context into a header map.
///
/// Writes `traceparent` (and optional `tracestate`) into the
/// returned map so they can be added to outgoing HTTP requests.
pub(crate) fn inject_context(cx: &Context) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let mut injector = MapInjector { map: &mut map };
    opentelemetry::global::get_text_map_propagator(|propagator| {
        propagator.inject_context(cx, &mut injector);
    });
    map
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_empty_headers() {
        // Extracting from empty headers should produce a valid (root) context.
        let headers = http::HeaderMap::new();
        let cx = extract_context(&headers);
        let injected = inject_context(&cx);
        // A root context with no active span produces no traceparent.
        assert!(injected.is_empty(), "root context should not inject traceparent");
    }

    #[test]
    fn extract_valid_traceparent() {
        // Ensure the W3C TraceContext propagator is registered for this test.
        opentelemetry::global::set_text_map_propagator(opentelemetry_sdk::propagation::TraceContextPropagator::new());
        let mut headers = http::HeaderMap::new();
        headers.insert(
            "traceparent",
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
                .parse()
                .unwrap_or_else(|_| std::process::abort()),
        );
        let cx = extract_context(&headers);
        let injected = inject_context(&cx);
        // Should preserve the trace ID.
        let tp = injected.get("traceparent").cloned().unwrap_or_default();
        assert!(
            tp.contains("4bf92f3577b34da6a3ce929d0e0e4736"),
            "trace ID must be preserved: {tp}"
        );
    }

    #[test]
    fn no_sensitive_headers_injected() {
        let headers = http::HeaderMap::new();
        let cx = extract_context(&headers);
        let injected = inject_context(&cx);
        for key in injected.keys() {
            let lower = key.to_lowercase();
            assert!(!lower.contains("authorization"), "must not inject auth");
            assert!(!lower.contains("cookie"), "must not inject cookies");
            assert!(!lower.contains("api-key"), "must not inject API keys");
        }
    }
}
