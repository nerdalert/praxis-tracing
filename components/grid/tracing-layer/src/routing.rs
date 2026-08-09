//! Routing event recording.
//!
//! Provides a structured way to record provider selection
//! decisions as span events with standardised attribute names.

use serde::Serialize;

/// A routing decision to record as a span event.
///
/// All fields are safe to include in telemetry — no prompt
/// content, response bodies, credentials, or session data.
#[derive(Debug, Clone, Serialize)]
pub struct RoutingEvent<'a> {
    /// Name of the selected provider backend.
    pub provider: &'a str,
    /// Cluster/site where the provider is hosted.
    pub cluster: &'a str,
    /// Computed composite score.
    pub score: f64,
    /// Zero-based rank among scored candidates.
    pub rank: u32,
    /// Active routing policy (e.g. `"scoreFirst"`).
    pub policy: &'a str,
    /// Human-readable decision summary.
    pub decision: &'a str,
}

/// Record a routing decision as a tracing event on the current span.
///
/// Creates a child span named `routing.select` containing all
/// routing attributes, then immediately drops it (point-in-time
/// event). This matches the Grid tracing convention where routing
/// decisions appear as short-lived child spans.
///
/// # Privacy
///
/// Only routing metadata is recorded — never prompt content,
/// response bodies, credentials, or session identifiers.
pub fn record_routing_event(event: &RoutingEvent<'_>) {
    let _span = tracing::info_span!(
        "routing.select",
        "selected.provider" = event.provider,
        "selected.cluster" = event.cluster,
        "provider.score" = event.score,
        "provider.rank" = event.rank,
        "routing.policy" = event.policy,
        "routing.decision" = event.decision,
    )
    .entered();

    tracing::info!(provider = event.provider, score = event.score, "routing decision");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routing_event_records_without_panic() {
        let event = RoutingEvent {
            provider: "llmd-pool-a-provider",
            cluster: "pool-a",
            score: 7.5,
            rank: 0,
            policy: "scoreFirst",
            decision: "selected pool-a (score=7.50)",
        };
        record_routing_event(&event);
    }

    #[test]
    fn routing_event_serializable() {
        let event = RoutingEvent {
            provider: "llmd-pool-b-provider",
            cluster: "pool-b",
            score: 5.2,
            rank: 1,
            policy: "scoreFirst",
            decision: "selected pool-b",
        };
        let json = serde_json::to_string(&event).unwrap_or_default();
        assert!(json.contains("pool-b"), "serialization includes provider");
        assert!(!json.contains("Bearer"), "no auth tokens");
        assert!(!json.contains("sk-"), "no API keys");
    }

    #[test]
    fn routing_event_no_sensitive_fields() {
        let event = RoutingEvent {
            provider: "test",
            cluster: "test",
            score: 1.0,
            rank: 0,
            policy: "scoreFirst",
            decision: "test decision",
        };
        let json = serde_json::to_string(&event).unwrap_or_default();
        assert!(!json.contains("prompt"), "no prompt field");
        assert!(!json.contains("body"), "no body field");
        assert!(!json.contains("cookie"), "no cookie field");
        assert!(!json.contains("authorization"), "no auth field");
    }
}
