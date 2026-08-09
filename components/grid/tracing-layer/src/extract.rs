//! W3C trace-context extraction and injection.
//!
//! Converts between [`http::HeaderMap`] and the OpenTelemetry
//! propagation API so that `traceparent` headers flow across
//! HTTP boundaries.

use std::collections::HashMap;

// ---------------------------------------------------------------------------
// Header adapters
// ---------------------------------------------------------------------------

/// Adapter that lets OpenTelemetry read from an [`http::HeaderMap`].
#[cfg(feature = "otel")]
struct HeaderExtractor<'a> {
    /// Borrowed header map to read from.
    headers: &'a http::HeaderMap,
}

#[cfg(feature = "otel")]
impl opentelemetry::propagation::Extractor for HeaderExtractor<'_> {
    fn get(&self, key: &str) -> Option<&str> {
        self.headers.get(key).and_then(|v| v.to_str().ok())
    }

    fn keys(&self) -> Vec<&str> {
        self.headers.keys().map(http::HeaderName::as_str).collect()
    }
}

/// Adapter that lets OpenTelemetry write into a [`HashMap`].
#[cfg(feature = "otel")]
struct MapInjector<'a> {
    /// Mutable map to write into.
    map: &'a mut HashMap<String, String>,
}

#[cfg(feature = "otel")]
impl opentelemetry::propagation::Injector for MapInjector<'_> {
    fn set(&mut self, key: &str, value: String) {
        self.map.insert(key.to_owned(), value);
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Extract trace context from incoming HTTP headers.
///
/// When the `otel` feature is enabled, reads the `traceparent`
/// (and optional `tracestate`) header and reconstructs the parent
/// span context. The returned value can be passed to
/// [`server_span`](crate::server_span) to link the new span.
///
/// Without `otel`, returns a default (no-op) context marker.
#[cfg(feature = "otel")]
pub fn extract_parent_context(headers: &http::HeaderMap) -> opentelemetry::Context {
    let extractor = HeaderExtractor { headers };
    opentelemetry::global::get_text_map_propagator(|p| p.extract(&extractor))
}

/// No-op extraction when OpenTelemetry is disabled.
///
/// Returns a unit value that can be passed to [`inject_trace_context`].
#[cfg(not(feature = "otel"))]
pub fn extract_parent_context(_headers: &http::HeaderMap) {}

/// Inject the current trace context into a header map for outbound requests.
///
/// When `otel` is enabled, writes `traceparent` (and `tracestate`)
/// into the returned map. These should be added to outgoing HTTP
/// requests before sending.
///
/// Without `otel`, returns an empty map.
#[cfg(feature = "otel")]
pub fn inject_trace_context(cx: &opentelemetry::Context) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let mut injector = MapInjector { map: &mut map };
    opentelemetry::global::get_text_map_propagator(|p| {
        p.inject_context(cx, &mut injector);
    });
    map
}

/// No-op injection when OpenTelemetry is disabled.
///
/// Returns an empty map since there is no trace context to propagate.
#[cfg(not(feature = "otel"))]
pub fn inject_trace_context() -> HashMap<String, String> {
    HashMap::new()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_headers_produce_valid_context() {
        crate::init_propagator();
        let headers = http::HeaderMap::new();
        extract_parent_context(&headers);
    }

    #[cfg(feature = "otel")]
    #[test]
    fn round_trip_traceparent() {
        crate::init_propagator();
        let mut headers = http::HeaderMap::new();
        headers.insert(
            "traceparent",
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
                .parse()
                .unwrap_or_else(|_| std::process::abort()),
        );
        let cx = extract_parent_context(&headers);
        let injected = inject_trace_context(&cx);
        let tp = injected.get("traceparent").cloned().unwrap_or_default();
        assert!(
            tp.contains("4bf92f3577b34da6a3ce929d0e0e4736"),
            "trace ID preserved: {tp}"
        );
    }

    #[cfg(feature = "otel")]
    #[test]
    fn no_sensitive_headers_in_injection() {
        crate::init_propagator();
        let headers = http::HeaderMap::new();
        let cx = extract_parent_context(&headers);
        let injected = inject_trace_context(&cx);
        for key in injected.keys() {
            let lower = key.to_lowercase();
            assert!(!lower.contains("authorization"), "no auth headers");
            assert!(!lower.contains("cookie"), "no cookies");
            assert!(!lower.contains("api-key"), "no API keys");
        }
    }
}
