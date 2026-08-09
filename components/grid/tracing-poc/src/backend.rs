//! Mock inference backend.
//!
//! Returns a canned OpenAI-compatible chat completion response for
//! every request, creating a tracing span with backend attributes.

use std::time::Duration;

use axum::{
    Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::post,
};
use tracing_opentelemetry::OpenTelemetrySpanExt as _;

use crate::propagation;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/// Shared state for a backend instance.
#[derive(Clone, Debug)]
struct BackendState {
    /// Pool name this backend belongs to.
    pool: String,
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/// Handle an inference request by returning a mock response.
async fn handle_inference(State(state): State<BackendState>, headers: HeaderMap, body: String) -> impl IntoResponse {
    // Extract parent trace context from incoming headers.
    let parent_cx = propagation::extract_context(&headers);

    let span = tracing::info_span!(
        "backend.inference",
        "service.name" = "mock-backend",
        "grid.pool" = %state.pool,
        "provider.kind" = "vllm-vcr",
        otel.kind = "SERVER",
    );
    span.set_parent(parent_cx);
    let _guard = span.enter();

    // Extract model from the request body (best-effort, no panic).
    let model = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v.get("model").and_then(|m| m.as_str()).map(String::from))
        .unwrap_or_else(|| "unknown".to_owned());

    tracing::info!(model = %model, pool = %state.pool, "processing inference");

    // Simulate processing latency.
    tokio::time::sleep(Duration::from_millis(50)).await;

    // Return a mock OpenAI chat completion response.
    let response = build_mock_response(&model, &state.pool);
    (StatusCode::OK, axum::Json(response))
}

/// Build a mock OpenAI-compatible chat completion response body.
fn build_mock_response(model: &str, pool: &str) -> serde_json::Value {
    serde_json::json!({
        "id": "chatcmpl-poc-mock",
        "object": "chat.completion",
        "model": model,
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": format!("Mock response from {pool}")
            },
            "finish_reason": "stop"
        }],
        "usage": {
            "prompt_tokens": 10,
            "completion_tokens": 8,
            "total_tokens": 18
        }
    })
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/// Start a mock backend on the given port.
///
/// # Errors
///
/// Returns when the server exits (normally does not return).
pub(crate) async fn serve(port: u16, pool: String) {
    let state = BackendState { pool: pool.clone() };
    let app = Router::new()
        .route("/v1/chat/completions", post(handle_inference))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{port}"))
        .await
        .unwrap_or_else(|_| std::process::abort());

    tracing::info!(port, pool = %pool, "backend listening");
    axum::serve(listener, app)
        .await
        .unwrap_or_else(|_| std::process::abort());
}
