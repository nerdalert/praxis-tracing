//! Jaeger API client for trace verification.
//!
//! Queries the Jaeger HTTP API to confirm that traces exported by
//! the POC are actually present and queryable, not just that the
//! collector started.

use crate::error::PocError;

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

/// Wait for Jaeger to become reachable, retrying up to 10 times.
///
/// # Errors
///
/// Returns [`PocError::Jaeger`] if Jaeger is not reachable after
/// all retries.
pub(crate) async fn wait_for_jaeger(jaeger_url: &str) -> Result<(), PocError> {
    let client = reqwest::Client::new();
    let url = format!("{jaeger_url}/api/services");

    for attempt in 1..=10_u32 {
        match client.get(&url).send().await {
            Ok(resp) if resp.status().is_success() => return Ok(()),
            Ok(resp) => {
                tracing::debug!(
                    attempt,
                    status = %resp.status(),
                    "jaeger not ready"
                );
            },
            Err(e) => {
                tracing::debug!(attempt, error = %e, "jaeger not reachable");
            },
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }

    Err(PocError::Jaeger(format!(
        "jaeger not reachable at {jaeger_url} after 10 attempts"
    )))
}

// ---------------------------------------------------------------------------
// Trace verification
// ---------------------------------------------------------------------------

/// Check that a trace with the given ID exists in Jaeger.
///
/// Returns the number of spans found, or an error if the trace
/// is missing or the API call fails.
///
/// # Errors
///
/// Returns [`PocError::Jaeger`] if the trace is not found.
/// Returns [`PocError::Http`] if the HTTP request fails.
pub(crate) async fn check_trace(jaeger_url: &str, trace_id: &str) -> Result<u32, PocError> {
    if trace_id == "unknown" || trace_id.is_empty() {
        return Err(PocError::Jaeger("no trace ID captured from response".to_owned()));
    }

    let client = reqwest::Client::new();
    let url = format!("{jaeger_url}/api/traces/{trace_id}");

    let resp = client.get(&url).send().await?;
    if !resp.status().is_success() {
        return Err(PocError::Jaeger(format!(
            "jaeger returned {} for trace {trace_id}",
            resp.status()
        )));
    }

    let body: serde_json::Value = resp.json().await?;
    let span_count = parse_span_count(&body);

    if span_count == 0 {
        return Err(PocError::Jaeger(format!("trace {trace_id} found but has 0 spans")));
    }

    Ok(span_count)
}

/// Parse the span count from a Jaeger trace API response body.
///
/// Navigates the `{ "data": [ { "spans": [...] } ] }` structure
/// and returns the number of spans in the first trace, or `0` if
/// the structure is unexpected.
fn parse_span_count(body: &serde_json::Value) -> u32 {
    body.get("data")
        .and_then(|d| d.as_array())
        .and_then(|arr| arr.first())
        .and_then(|trace| trace.get("spans"))
        .and_then(|s| s.as_array())
        .map_or(0, |spans| u32::try_from(spans.len()).unwrap_or(u32::MAX))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_trace_id_fails() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap_or_else(|_| std::process::abort());
        let result = rt.block_on(check_trace("http://localhost:16686", "unknown"));
        assert!(result.is_err(), "unknown trace ID should fail");
    }

    #[test]
    fn empty_trace_id_fails() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap_or_else(|_| std::process::abort());
        let result = rt.block_on(check_trace("http://localhost:16686", ""));
        assert!(result.is_err(), "empty trace ID should fail");
    }
}
