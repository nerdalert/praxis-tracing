//! Error types for the tracing POC.

// ---------------------------------------------------------------------------
// POC Error
// ---------------------------------------------------------------------------

/// Errors that can occur during the tracing POC.
#[derive(Debug, thiserror::Error)]
pub(crate) enum PocError {
    /// Jaeger is not reachable or returned an unexpected response.
    #[error("jaeger: {0}")]
    Jaeger(String),

    /// HTTP request failed.
    #[error("http: {0}")]
    Http(#[from] reqwest::Error),

    /// JSON parsing failed.
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),

    /// Trace verification failed.
    #[error("validation: {0}")]
    Validation(String),

    /// Telemetry initialisation failed.
    #[error("telemetry: {0}")]
    Telemetry(String),
}
