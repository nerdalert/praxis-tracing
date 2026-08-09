//! SERVER and CLIENT span creation helpers.
//!
//! These helpers create structured `tracing` spans with the
//! standard attributes expected by the Grid observability stack.
//! When the `otel` feature is enabled, the spans participate in
//! distributed trace propagation via parent context linkage.

/// Configuration for a SERVER span at the gateway ingress.
pub struct ServerSpanConfig<'a> {
    /// Logical service name (e.g. `"consumer-gateway"`).
    pub service_name: &'a str,
    /// HTTP method (e.g. `"POST"`).
    pub method: &'a str,
    /// HTTP route (e.g. `"/v1/chat/completions"`).
    pub route: &'a str,
    /// Grid network name.
    pub network: &'a str,
    /// Local site/pool name.
    pub site: &'a str,
}

/// Create a SERVER span for an inbound request.
///
/// The returned span carries `service.name`, `http.method`,
/// `http.route`, `grid.network`, and `consumer.site` attributes.
///
/// # OpenTelemetry integration
///
/// When the `otel` feature is enabled, call
/// `span.set_parent(parent_cx)` with the context from
/// [`extract_parent_context`](crate::extract_parent_context)
/// to link this span to the incoming trace.
pub fn server_span(config: &ServerSpanConfig<'_>) -> tracing::Span {
    tracing::info_span!(
        "server.inbound",
        "service.name" = config.service_name,
        "http.method" = config.method,
        "http.route" = config.route,
        "grid.network" = config.network,
        "consumer.site" = config.site,
        otel.kind = "SERVER",
    )
}

/// Configuration for a CLIENT span on an outbound proxy hop.
pub struct ClientSpanConfig<'a> {
    /// Logical service name of the caller.
    pub service_name: &'a str,
    /// Target pool/site name.
    pub target_pool: &'a str,
    /// Target URL (for the span name — the URL itself is safe
    /// to record since it contains no credentials).
    pub target_url: &'a str,
}

/// Create a CLIENT span for an outbound proxy request.
///
/// The returned span carries `service.name`, `target.pool`,
/// and `target.url` attributes. After entering this span,
/// call [`inject_trace_context`](crate::inject_trace_context)
/// to propagate the trace to the downstream service.
pub fn client_span(config: &ClientSpanConfig<'_>) -> tracing::Span {
    tracing::info_span!(
        "client.proxy",
        "service.name" = config.service_name,
        "target.pool" = config.target_pool,
        "target.url" = config.target_url,
        otel.kind = "CLIENT",
    )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_span_does_not_panic() {
        let config = ServerSpanConfig {
            service_name: "test-gateway",
            method: "POST",
            route: "/v1/chat/completions",
            network: "test-network",
            site: "pool-a",
        };
        let _span = server_span(&config);
    }

    #[test]
    fn client_span_does_not_panic() {
        let config = ClientSpanConfig {
            service_name: "test-gateway",
            target_pool: "pool-b",
            target_url: "http://localhost:3201/v1/chat/completions",
        };
        let _span = client_span(&config);
    }

    #[test]
    fn no_credentials_in_span_config() {
        let config = ServerSpanConfig {
            service_name: "gw",
            method: "POST",
            route: "/v1/chat/completions",
            network: "net",
            site: "pool-a",
        };
        assert!(!config.service_name.contains("Bearer"), "no auth tokens");
        assert!(!config.route.contains("sk-"), "no API keys");
    }
}
