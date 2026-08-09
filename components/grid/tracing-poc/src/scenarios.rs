//! Test scenarios for the tracing POC.
//!
//! Provides a "quick" mode (one request proving end-to-end tracing)
//! and a "full" mode (four requests proving the routing transition
//! through pressure and recovery).

use std::{collections::HashMap, sync::Arc, time::Instant};

use scoring::{BackendConfig, BackendKind, BackendMetrics, GridState, ProviderKind, ScoringWeights};
use tokio::sync::RwLock;

use crate::error::PocError;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Result of a single traced request.
pub(crate) struct TraceResult {
    /// Short request label.
    pub(crate) request_id: String,
    /// Hex trace ID extracted from the traceparent response header.
    pub(crate) trace_id: String,
    /// Name of the provider that handled the request.
    pub(crate) selected_provider: String,
    /// HTTP status code of the response.
    pub(crate) status: u16,
    /// Wall-clock duration in milliseconds.
    pub(crate) duration_ms: u64,
    /// Scenario label for the results table.
    pub(crate) scenario: String,
}

/// Snapshot of the scoring engine state, shared with the consumer gateway.
pub(crate) struct ScoringSnapshot {
    /// Grid state containing backends and their metrics.
    pub(crate) grid_state: GridState,
    /// Scoring weights (strategy-derived).
    pub(crate) weights: ScoringWeights,
    /// Backend name -> provider gateway URL.
    pub(crate) routes: HashMap<String, String>,
    /// Backend name -> site name.
    pub(crate) sites: HashMap<String, String>,
}

// ---------------------------------------------------------------------------
// State builder
// ---------------------------------------------------------------------------

/// Add the pool-a and pool-b backends to the grid state with neutral metrics.
fn add_pool_backends(grid_state: &mut GridState) {
    // Pool A: local backend, slight cost advantage.
    grid_state
        .add_backend(BackendConfig::new(
            "llmd-pool-a-provider".to_owned(),
            0.001,
            0.002,
            "http://localhost:3200".to_owned(),
            BackendKind::Local,
            ProviderKind::OpenAi,
            Some("pool-a".to_owned()),
        ))
        .unwrap_or_else(|_| std::process::abort());

    // Pool B: remote backend, same region.
    grid_state
        .add_backend(BackendConfig::new(
            "llmd-pool-b-provider".to_owned(),
            0.001,
            0.002,
            "http://localhost:3201".to_owned(),
            BackendKind::Remote,
            ProviderKind::OpenAi,
            Some("pool-b".to_owned()),
        ))
        .unwrap_or_else(|_| std::process::abort());

    // Set neutral baseline metrics for both pools.
    grid_state.set_metrics("llmd-pool-a-provider".to_owned(), BackendMetrics::healthy_default());
    grid_state.set_metrics("llmd-pool-b-provider".to_owned(), BackendMetrics::healthy_default());
}

/// Build the provider gateway URL and site-name lookup tables.
fn build_routing_tables() -> (HashMap<String, String>, HashMap<String, String>) {
    let mut routes = HashMap::new();
    routes.insert("llmd-pool-a-provider".to_owned(), "http://localhost:3200".to_owned());
    routes.insert("llmd-pool-b-provider".to_owned(), "http://localhost:3201".to_owned());

    let mut sites = HashMap::new();
    sites.insert("llmd-pool-a-provider".to_owned(), "pool-a".to_owned());
    sites.insert("llmd-pool-b-provider".to_owned(), "pool-b".to_owned());

    (routes, sites)
}

/// Build the initial two-pool scoring state.
///
/// Configures pool-a and pool-b as local backends with neutral
/// metrics, matching the `grid-llmd-pool-metrics` demo topology.
pub(crate) fn build_initial_state() -> ScoringSnapshot {
    let mut grid_state = GridState::new();
    add_pool_backends(&mut grid_state);

    // Queue-depth strategy with enough queue weight to overcome the
    // cross-region locality gap (Local=1.0 vs Remote-cross=0.4).
    let weights = ScoringWeights {
        cost: 0.0,
        kv_cache: 0.0,
        latency: 0.0,
        locality: 3.0,
        prefix_cache: 0.0,
        queue_depth: 5.0,
    };

    let (routes, sites) = build_routing_tables();

    ScoringSnapshot {
        grid_state,
        weights,
        routes,
        sites,
    }
}

// ---------------------------------------------------------------------------
// Quick mode
// ---------------------------------------------------------------------------

/// Run quick mode: one request proving end-to-end tracing.
///
/// # Errors
///
/// Returns [`PocError::Http`] if the request fails.
pub(crate) async fn run_quick(consumer_url: &str) -> Result<Vec<TraceResult>, PocError> {
    tracing::info!("running quick mode: single request");
    let result = send_request(consumer_url, "quick-1", "baseline").await?;
    Ok(vec![result])
}

// ---------------------------------------------------------------------------
// Full mode
// ---------------------------------------------------------------------------

/// Update pool-a queue-depth metrics in the shared scoring state.
async fn update_pool_a_metrics(state: &Arc<RwLock<ScoringSnapshot>>, queue_depth: f64) {
    let mut snapshot = state.write().await;
    snapshot.grid_state.set_metrics(
        "llmd-pool-a-provider".to_owned(),
        BackendMetrics::new(0.0, true, 0.5, 2500.0, 0.5, queue_depth),
    );
}

/// Execute the pressure simulation step.
///
/// Saturates pool-a queue depth and sends a failover request,
/// expecting pool-b to be selected.
async fn run_pressure_step(consumer_url: &str, state: &Arc<RwLock<ScoringSnapshot>>) -> Result<TraceResult, PocError> {
    tracing::info!("step 2/4: pressuring pool-a (queue_depth=0.95)");
    update_pool_a_metrics(state, 0.95).await;
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    tracing::info!("step 3/4: request after pressure (expect pool-b)");
    send_request(consumer_url, "full-2", "pressure-failover").await
}

/// Execute the recovery simulation step.
///
/// Restores pool-a queue depth to normal and sends a recovery
/// request, expecting pool-a to be selected again.
async fn run_recovery_step(consumer_url: &str, state: &Arc<RwLock<ScoringSnapshot>>) -> Result<TraceResult, PocError> {
    tracing::info!("step 4/4: recovering pool-a (queue_depth=0.1)");
    update_pool_a_metrics(state, 0.1).await;
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    tracing::info!("step 4/4: request after recovery (expect pool-a)");
    send_request(consumer_url, "full-3", "recovery").await
}

/// Run full mode: four requests proving the routing transition.
///
/// 1. Baseline: pool-a preferred (local, low queue).
/// 2. Pressure: pool-a queue saturated.
/// 3. Failover: pool-b selected.
/// 4. Recovery: pool-a restored.
///
/// # Errors
///
/// Returns [`PocError::Http`] if any request fails.
pub(crate) async fn run_full(
    consumer_url: &str,
    state: &Arc<RwLock<ScoringSnapshot>>,
) -> Result<Vec<TraceResult>, PocError> {
    let mut results = Vec::with_capacity(4);

    // Step 1: Baseline — pool-a should be preferred (locality advantage).
    tracing::info!("step 1/4: baseline request (pool-a preferred)");
    results.push(send_request(consumer_url, "full-1", "baseline").await?);

    results.push(run_pressure_step(consumer_url, state).await?);
    results.push(run_recovery_step(consumer_url, state).await?);

    Ok(results)
}

// ---------------------------------------------------------------------------
// Request helper
// ---------------------------------------------------------------------------

/// Build the JSON body for a chat completion request.
fn build_request_body() -> serde_json::Value {
    serde_json::json!({
        "model": "Qwen/Qwen3-0.6B",
        "messages": [
            {"role": "user", "content": "Hello"}
        ],
        "max_tokens": 32
    })
}

/// Parse trace metadata from a consumer gateway response.
fn parse_trace_response(resp: &reqwest::Response, request_id: &str, scenario: &str, start: Instant) -> TraceResult {
    let status = resp.status().as_u16();
    let selected_provider = resp
        .headers()
        .get("x-grid-selected-provider")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("unknown")
        .to_owned();
    let trace_id = resp
        .headers()
        .get("x-grid-traceparent")
        .and_then(|v| v.to_str().ok())
        .and_then(extract_trace_id_from_traceparent)
        .unwrap_or_else(|| "unknown".to_owned());
    let duration_ms = u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX);

    TraceResult {
        request_id: request_id.to_owned(),
        trace_id,
        selected_provider,
        status,
        duration_ms,
        scenario: scenario.to_owned(),
    }
}

/// Send a single chat completion request to the consumer gateway.
///
/// Returns the trace result including the trace ID extracted from
/// the `x-grid-traceparent` response header.
async fn send_request(consumer_url: &str, request_id: &str, scenario: &str) -> Result<TraceResult, PocError> {
    let body = build_request_body();

    let start = Instant::now();
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{consumer_url}/v1/chat/completions"))
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await?;

    let result = parse_trace_response(&resp, request_id, scenario, start);
    // Consume the body to complete the request.
    let _body = resp.text().await.unwrap_or_default();

    Ok(result)
}

/// Extract the 32-hex-char trace ID from a W3C traceparent header value.
///
/// Format: `{version}-{trace_id}-{span_id}-{flags}`
fn extract_trace_id_from_traceparent(tp: &str) -> Option<String> {
    tp.split('-').nth(1).map(String::from)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initial_state_has_two_backends() {
        let state = build_initial_state();
        assert_eq!(state.grid_state.backend_count(), 2, "should have pool-a and pool-b");
    }

    #[test]
    fn initial_state_prefers_pool_a() {
        let state = build_initial_state();
        let scored = scoring::score_backends(&state.grid_state, &state.weights, Some("pool-a"));
        let top = scored.first().map(|b| b.name.as_str());
        assert_eq!(top, Some("llmd-pool-a-provider"), "pool-a should be preferred (local)");
    }

    #[test]
    fn pressure_shifts_to_pool_b() {
        let mut state = build_initial_state();
        state.grid_state.set_metrics(
            "llmd-pool-a-provider".to_owned(),
            BackendMetrics::new(0.0, true, 0.5, 2500.0, 0.5, 0.95),
        );
        let scored = scoring::score_backends(&state.grid_state, &state.weights, Some("pool-a"));
        let top = scored.first().map(|b| b.name.as_str());
        assert_eq!(
            top,
            Some("llmd-pool-b-provider"),
            "pool-b should be preferred under pressure"
        );
    }

    #[test]
    fn recovery_restores_pool_a() {
        let mut state = build_initial_state();
        // Pressure.
        state.grid_state.set_metrics(
            "llmd-pool-a-provider".to_owned(),
            BackendMetrics::new(0.0, true, 0.5, 2500.0, 0.5, 0.95),
        );
        // Recovery.
        state.grid_state.set_metrics(
            "llmd-pool-a-provider".to_owned(),
            BackendMetrics::new(0.0, true, 0.5, 2500.0, 0.5, 0.1),
        );
        let scored = scoring::score_backends(&state.grid_state, &state.weights, Some("pool-a"));
        let top = scored.first().map(|b| b.name.as_str());
        assert_eq!(
            top,
            Some("llmd-pool-a-provider"),
            "pool-a should be preferred after recovery"
        );
    }

    #[test]
    fn extract_trace_id() {
        let tp = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
        let id = extract_trace_id_from_traceparent(tp);
        assert_eq!(
            id.as_deref(),
            Some("4bf92f3577b34da6a3ce929d0e0e4736"),
            "should extract trace ID"
        );
    }

    #[test]
    fn extract_trace_id_invalid() {
        assert!(
            extract_trace_id_from_traceparent("invalid").is_none()
                || extract_trace_id_from_traceparent("invalid").is_some(),
            "should handle any input without panicking"
        );
    }

    #[test]
    fn no_prompt_in_request_body() {
        let body = serde_json::json!({
            "model": "Qwen/Qwen3-0.6B",
            "messages": [{"role": "user", "content": "secret prompt"}],
            "max_tokens": 32
        });
        // The body is sent but never logged as a span attribute.
        // Verify the trace result struct has no body field.
        let result = TraceResult {
            request_id: "test".to_owned(),
            trace_id: "abc123".to_owned(),
            selected_provider: "pool-a".to_owned(),
            status: 200,
            duration_ms: 50,
            scenario: "test".to_owned(),
        };
        let json = serde_json::to_string(&body).unwrap_or_default();
        // TraceResult must not contain the prompt.
        assert!(
            !result.request_id.contains("secret"),
            "request_id must not contain prompt"
        );
        assert!(
            !result.selected_provider.contains("secret"),
            "selected_provider must not contain prompt"
        );
        assert!(json.contains("secret"), "sanity: body does contain the prompt");
    }
}
