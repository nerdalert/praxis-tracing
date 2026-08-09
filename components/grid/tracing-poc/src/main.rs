//! OpenTelemetry + Jaeger tracing proof-of-concept for the AI Grid.
//!
//! Simulates the Grid request path (consumer gateway -> provider gateway ->
//! backend) with real scoring decisions and W3C trace-context propagation,
//! exporting spans to Jaeger via an OpenTelemetry Collector.

mod backend;
mod error;
mod gateway;
mod propagation;
mod scenarios;
mod telemetry;
mod verify;

use std::sync::Arc;

use clap::Parser;
use tokio::sync::RwLock;

use crate::error::PocError;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/// OpenTelemetry + Jaeger tracing POC for the AI Grid.
#[derive(Debug, Parser)]
#[command(name = "tracing-poc")]
struct Cli {
    /// Run mode: "quick" for one request, "full" for routing transition.
    #[arg(long, default_value = "quick")]
    mode: String,

    /// OTLP HTTP endpoint for the OpenTelemetry Collector.
    #[arg(long, default_value = "http://localhost:4318")]
    otlp_endpoint: String,

    /// Jaeger query API base URL.
    #[arg(long, default_value = "http://localhost:16686")]
    jaeger_url: String,

    /// Consumer gateway listen port.
    #[arg(long, default_value_t = 3100)]
    consumer_port: u16,

    /// Pool-A provider gateway listen port.
    #[arg(long, default_value_t = 3200)]
    provider_a_port: u16,

    /// Pool-B provider gateway listen port.
    #[arg(long, default_value_t = 3201)]
    provider_b_port: u16,

    /// Pool-A backend listen port.
    #[arg(long, default_value_t = 3300)]
    backend_a_port: u16,

    /// Pool-B backend listen port.
    #[arg(long, default_value_t = 3301)]
    backend_b_port: u16,

    /// Skip Docker infrastructure checks.
    #[arg(long)]
    skip_infra_check: bool,
}

// ---------------------------------------------------------------------------
// Service startup
// ---------------------------------------------------------------------------

/// Spawn all mock services (backends, provider gateways, consumer gateway).
fn spawn_services(cli: &Cli, state: Arc<RwLock<scenarios::ScoringSnapshot>>) {
    tokio::spawn(backend::serve(cli.backend_a_port, "pool-a".to_owned()));
    tokio::spawn(backend::serve(cli.backend_b_port, "pool-b".to_owned()));
    tokio::spawn(gateway::serve_provider(
        cli.provider_a_port,
        "pool-a".to_owned(),
        format!("http://localhost:{}", cli.backend_a_port),
    ));
    tokio::spawn(gateway::serve_provider(
        cli.provider_b_port,
        "pool-b".to_owned(),
        format!("http://localhost:{}", cli.backend_b_port),
    ));
    tokio::spawn(gateway::serve_consumer(cli.consumer_port, state));
}

// ---------------------------------------------------------------------------
// Trace ingestion polling
// ---------------------------------------------------------------------------

/// Poll Jaeger until at least one trace from the results is queryable,
/// or until a 15-second timeout expires.
async fn wait_for_trace_ingestion(jaeger_url: &str, results: &[scenarios::TraceResult]) {
    let first_id = results.first().map_or("unknown", |r| r.trace_id.as_str());

    for _ in 0..15_u32 {
        if verify::check_trace(jaeger_url, first_id).await.is_ok() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
    tracing::warn!("trace ingestion poll timed out; proceeding with verification");
}

// ---------------------------------------------------------------------------
// Result display
// ---------------------------------------------------------------------------

/// Print the results table and Jaeger UI URL.
#[expect(clippy::print_stdout, reason = "CLI output for POC results")]
fn print_results(results: &[scenarios::TraceResult], jaeger_url: &str) {
    println!();
    println!(
        "{:<12} {:<34} {:<20} {:<8} {:<12} SCENARIO",
        "REQUEST", "TRACE_ID", "SELECTED_PROVIDER", "STATUS", "DURATION_MS"
    );
    println!("{}", "-".repeat(100));
    for r in results {
        println!(
            "{:<12} {:<34} {:<20} {:<8} {:<12} {}",
            r.request_id, r.trace_id, r.selected_provider, r.status, r.duration_ms, r.scenario,
        );
    }
    println!();
    println!("Jaeger UI: {jaeger_url}/search");
    println!();
}

/// Verify all traces in Jaeger and print the results.
///
/// Returns the number of failed verifications.
#[expect(clippy::print_stdout, reason = "CLI output for POC results")]
async fn verify_traces(results: &[scenarios::TraceResult], jaeger_url: &str) -> u32 {
    let mut verified = 0_u32;
    let mut failed = 0_u32;
    for r in results {
        match verify::check_trace(jaeger_url, &r.trace_id).await {
            Ok(span_count) => {
                println!("  [ok] trace {} — {} spans found", r.trace_id, span_count);
                verified = verified.saturating_add(1);
            },
            Err(e) => {
                println!("  [FAIL] trace {} — {e}", r.trace_id);
                failed = failed.saturating_add(1);
            },
        }
    }
    println!();
    println!("verified: {verified}, failed: {failed}");
    failed
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/// Run the tracing POC.
#[tokio::main]
async fn main() -> Result<(), PocError> {
    let cli = Cli::parse();

    let provider = telemetry::init(&cli.otlp_endpoint)?;
    tracing::info!("tracing POC starting in {} mode", cli.mode);

    if !cli.skip_infra_check {
        verify::wait_for_jaeger(&cli.jaeger_url).await?;
        tracing::info!("jaeger reachable at {}", cli.jaeger_url);
    }

    let state = Arc::new(RwLock::new(scenarios::build_initial_state()));
    spawn_services(&cli, Arc::clone(&state));
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    let consumer_url = format!("http://localhost:{}", cli.consumer_port);
    let results = match cli.mode.as_str() {
        "full" => scenarios::run_full(&consumer_url, &state).await?,
        _ => scenarios::run_quick(&consumer_url).await?,
    };

    telemetry::flush(&provider);
    wait_for_trace_ingestion(&cli.jaeger_url, &results).await;

    print_results(&results, &cli.jaeger_url);
    let failed = verify_traces(&results, &cli.jaeger_url).await;

    if failed > 0 {
        return Err(PocError::Validation(format!("{failed} traces not found in Jaeger")));
    }

    Ok(())
}
