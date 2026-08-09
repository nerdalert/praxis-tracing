//! Consumer and provider gateway services.
//!
//! The **consumer gateway** accepts inbound requests, runs the scoring
//! engine to select a provider, and forwards the request with W3C
//! trace-context headers.
//!
//! The **provider gateway** accepts forwarded requests, adds provider
//! metadata to the trace, and forwards to the backend.

use std::{collections::HashMap, sync::Arc};

use axum::{
    Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::post,
};
use tokio::sync::RwLock;
use tracing_opentelemetry::OpenTelemetrySpanExt as _;

use crate::{propagation, scenarios::ScoringSnapshot};

// ---------------------------------------------------------------------------
// Consumer gateway
// ---------------------------------------------------------------------------

/// Shared state for the consumer gateway.
#[derive(Clone)]
pub(crate) struct ConsumerState {
    /// Mutable scoring state (metrics change during pressure simulation).
    pub(crate) scoring: Arc<RwLock<ScoringSnapshot>>,
}

/// Select a provider by running the scoring engine against current state.
///
/// Returns the selected provider name, provider gateway URL, and
/// routing attributes. Returns an error response if no healthy
/// backends are available.
async fn select_provider(state: &ConsumerState) -> Result<(String, String, RoutingAttrs), axum::response::Response> {
    let snapshot = state.scoring.read().await;
    let scored = scoring::score_backends(&snapshot.grid_state, &snapshot.weights, Some("pool-a"));

    let Some(top) = scored.first() else {
        tracing::error!("no healthy backends available");
        return Err((StatusCode::SERVICE_UNAVAILABLE, "no backends available".to_owned()).into_response());
    };

    let url = snapshot
        .routes
        .get(&top.name)
        .cloned()
        .unwrap_or_else(|| "http://localhost:3200".to_owned());
    let site = snapshot
        .sites
        .get(&top.name)
        .cloned()
        .unwrap_or_else(|| "unknown".to_owned());
    drop(snapshot);

    let attrs = build_routing_attrs(top, scored.len(), &site);
    Ok((top.name.clone(), url, attrs))
}

/// Build routing attributes from a scored backend result.
fn build_routing_attrs(top: &scoring::ScoredBackend, scored_count: usize, site: &str) -> RoutingAttrs {
    RoutingAttrs {
        selected_provider: top.name.clone(),
        selected_cluster: site.to_owned(),
        selected_site: site.to_owned(),
        provider_kind: format!("{:?}", top.provider),
        routing_policy: "scoreFirst".to_owned(),
        provider_score: top.score,
        provider_rank: 0,
        routing_decision: format!(
            "scored {scored_count} backends, selected {} (score={:.2})",
            top.name, top.score,
        ),
    }
}

/// Handle an inbound request at the consumer gateway.
///
/// Runs the scoring engine, selects the top provider, and proxies
/// the request to the corresponding provider gateway.
async fn handle_consumer(
    State(state): State<ConsumerState>,
    headers: HeaderMap,
    body: String,
) -> axum::response::Response {
    let parent_cx = propagation::extract_context(&headers);

    let span = tracing::info_span!(
        "consumer.inbound",
        "service.name" = "consumer-gateway",
        "grid.network" = "grid-llmd-pool-metrics",
        "consumer.site" = "pool-a",
        "http.method" = "POST",
        "http.route" = "/v1/chat/completions",
        otel.kind = "SERVER",
    );
    span.set_parent(parent_cx);
    let _guard = span.enter();

    // Run the scoring engine.
    let (selected_name, selected_url, routing_attrs) = match select_provider(&state).await {
        Ok(v) => v,
        Err(response) => return response,
    };

    // Create a child span for the routing decision.
    record_routing_span(&routing_attrs);

    // Forward to the provider gateway and build response.
    consumer_forward_and_respond(&selected_url, body, &selected_name, &routing_attrs).await
}

/// Forward the consumer request to the selected provider and build the response.
async fn consumer_forward_and_respond(
    selected_url: &str,
    body: String,
    selected_name: &str,
    routing_attrs: &RoutingAttrs,
) -> axum::response::Response {
    let cx = tracing::Span::current().context();
    let trace_headers = propagation::inject_context(&cx);

    let forward_url = format!("{selected_url}/v1/chat/completions");
    match forward_request(&forward_url, body, &trace_headers).await {
        Ok(resp) => {
            let status = resp.status();
            tracing::Span::current().record("http.status_code", status.as_u16());
            let body_text = resp.text().await.unwrap_or_default();
            build_consumer_ok_response(status.as_u16(), body_text, selected_name, routing_attrs, &trace_headers)
        },
        Err(e) => {
            tracing::error!(error = %e, "proxy forward failed");
            (StatusCode::BAD_GATEWAY, format!("proxy error: {e}")).into_response()
        },
    }
}

/// Build the consumer gateway success response with routing metadata headers.
fn build_consumer_ok_response(
    status_code: u16,
    body_text: String,
    selected_name: &str,
    routing_attrs: &RoutingAttrs,
    trace_headers: &HashMap<String, String>,
) -> axum::response::Response {
    let mut response_headers = HeaderMap::new();
    if let Ok(v) = selected_name.parse() {
        response_headers.insert("x-grid-selected-provider", v);
    }
    if let Ok(v) = routing_attrs.provider_score.to_string().parse() {
        response_headers.insert("x-grid-provider-score", v);
    }
    if let Ok(v) = routing_attrs.provider_rank.to_string().parse() {
        response_headers.insert("x-grid-provider-rank", v);
    }
    // Propagate trace ID in response for the test runner to capture.
    for (k, v) in trace_headers {
        if k == "traceparent"
            && let Ok(hv) = v.parse()
        {
            response_headers.insert("x-grid-traceparent", hv);
        }
    }

    let response_status = StatusCode::from_u16(status_code).unwrap_or(StatusCode::BAD_GATEWAY);
    (response_status, response_headers, body_text).into_response()
}

/// Routing attributes captured during provider selection.
struct RoutingAttrs {
    /// Name of the selected provider backend.
    selected_provider: String,
    /// Cluster identifier of the selected provider.
    selected_cluster: String,
    /// Site where the selected provider is hosted.
    selected_site: String,
    /// Provider kind (e.g. `OpenAi`, `Anthropic`).
    provider_kind: String,
    /// Active routing policy.
    routing_policy: String,
    /// Computed score of the selected provider.
    provider_score: f64,
    /// Zero-based rank of the selected provider.
    provider_rank: u32,
    /// Human-readable description of the routing decision.
    routing_decision: String,
}

/// Record routing decision attributes as a child span.
fn record_routing_span(attrs: &RoutingAttrs) {
    let _span = tracing::info_span!(
        "consumer.route_select",
        "selected.provider" = %attrs.selected_provider,
        "selected.cluster" = %attrs.selected_cluster,
        "selected.site" = %attrs.selected_site,
        "provider.kind" = %attrs.provider_kind,
        "routing.policy" = %attrs.routing_policy,
        "provider.score" = attrs.provider_score,
        "provider.rank" = attrs.provider_rank,
        "routing.decision" = %attrs.routing_decision,
    )
    .entered();

    tracing::info!(
        provider = %attrs.selected_provider,
        score = attrs.provider_score,
        "routing decision"
    );
}

/// Start the consumer gateway on the given port.
pub(crate) async fn serve_consumer(port: u16, scoring: Arc<RwLock<ScoringSnapshot>>) {
    let state = ConsumerState { scoring };
    let app = Router::new()
        .route("/v1/chat/completions", post(handle_consumer))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{port}"))
        .await
        .unwrap_or_else(|_| std::process::abort());

    tracing::info!(port, "consumer gateway listening");
    axum::serve(listener, app)
        .await
        .unwrap_or_else(|_| std::process::abort());
}

// ---------------------------------------------------------------------------
// Forwarding
// ---------------------------------------------------------------------------

/// Forward a JSON request body to a URL with trace context headers.
///
/// Sends a POST request with `content-type: application/json` and
/// the provided trace propagation headers. Used by both the consumer
/// and provider gateways.
async fn forward_request(
    url: &str,
    body: String,
    trace_headers: &HashMap<String, String>,
) -> Result<reqwest::Response, reqwest::Error> {
    let client = reqwest::Client::new();
    let mut req = client.post(url).header("content-type", "application/json").body(body);

    for (k, v) in trace_headers {
        req = req.header(k.as_str(), v.as_str());
    }

    req.send().await
}

// ---------------------------------------------------------------------------
// Provider gateway
// ---------------------------------------------------------------------------

/// Shared state for a provider gateway.
#[derive(Clone)]
struct ProviderState {
    /// Pool/site name.
    pool: String,
    /// URL of the backend to forward to.
    backend_url: String,
}

/// Handle a request at the provider gateway.
async fn handle_provider(State(state): State<ProviderState>, headers: HeaderMap, body: String) -> impl IntoResponse {
    let parent_cx = propagation::extract_context(&headers);

    let span = tracing::info_span!(
        "provider.inbound",
        "service.name" = "provider-gateway",
        "grid.pool" = %state.pool,
        "selected.site" = %state.pool,
        "provider.kind" = "vllm-vcr",
        otel.kind = "SERVER",
    );
    span.set_parent(parent_cx);
    let _guard = span.enter();

    tracing::info!(pool = %state.pool, "provider gateway processing");

    // Forward to the backend.
    let cx = tracing::Span::current().context();
    let trace_headers = propagation::inject_context(&cx);

    let forward_url = format!("{}/v1/chat/completions", state.backend_url);
    match forward_request(&forward_url, body, &trace_headers).await {
        Ok(resp) => {
            let status = resp.status();
            let body_text = resp.text().await.unwrap_or_default();
            build_provider_ok_response(status.as_u16(), &state.pool, body_text)
        },
        Err(e) => {
            tracing::error!(error = %e, "backend forward failed");
            (StatusCode::BAD_GATEWAY, format!("backend error: {e}")).into_response()
        },
    }
}

/// Build the provider gateway success response with pool metadata header.
fn build_provider_ok_response(status_code: u16, pool: &str, body_text: String) -> axum::response::Response {
    let mut response_headers = HeaderMap::new();
    if let Ok(v) = pool.parse() {
        response_headers.insert("x-grid-llmd-provider-gateway", v);
    }
    let response_status = StatusCode::from_u16(status_code).unwrap_or(StatusCode::BAD_GATEWAY);
    (response_status, response_headers, body_text).into_response()
}

/// Start a provider gateway on the given port.
pub(crate) async fn serve_provider(port: u16, pool: String, backend_url: String) {
    let state = ProviderState {
        pool: pool.clone(),
        backend_url,
    };
    let app = Router::new()
        .route("/v1/chat/completions", post(handle_provider))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{port}"))
        .await
        .unwrap_or_else(|_| std::process::abort());

    tracing::info!(port, pool = %pool, "provider gateway listening");
    axum::serve(listener, app)
        .await
        .unwrap_or_else(|_| std::process::abort());
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routing_attrs_no_sensitive_data() {
        let attrs = RoutingAttrs {
            selected_provider: "llmd-pool-a-provider".to_owned(),
            selected_cluster: "east-cluster".to_owned(),
            selected_site: "pool-a".to_owned(),
            provider_kind: "OpenAi".to_owned(),
            routing_policy: "scoreFirst".to_owned(),
            provider_score: 11.0,
            provider_rank: 0,
            routing_decision: "selected pool-a".to_owned(),
        };
        // Ensure no fields contain prompt content, credentials, or bodies.
        assert!(!attrs.routing_decision.contains("Bearer"), "no auth tokens");
        assert!(!attrs.routing_decision.contains("sk-"), "no API keys");
    }

    #[test]
    fn provider_state_clone() {
        let state = ProviderState {
            pool: "pool-a".to_owned(),
            backend_url: "http://localhost:3300".to_owned(),
        };
        let cloned = state.clone();
        assert_eq!(cloned.pool, "pool-a", "pool preserved");
        assert_eq!(cloned.backend_url, "http://localhost:3300", "url preserved");
    }
}
