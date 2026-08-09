#!/usr/bin/env bash
# Start the tracing POC infrastructure and run the test scenarios.
#
# Usage:
#   ./tracing-poc/scripts/run-poc.sh              # quick mode
#   ./tracing-poc/scripts/run-poc.sh --mode full   # full routing transition
#
# Prerequisites:
#   - Docker (for Jaeger + OTel Collector)
#   - Rust 1.96+ (for building the POC binary)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POC_DIR="$(dirname "${SCRIPT_DIR}")"
GRID_DIR="$(dirname "${POC_DIR}")"
COMPOSE_FILE="${POC_DIR}/docker/docker-compose.yaml"

echo "=== Grid Tracing POC ==="
echo ""

# Start infrastructure.
echo "Starting Jaeger + OTel Collector..."
docker compose -f "${COMPOSE_FILE}" up -d --wait 2>/dev/null || {
    echo "ERROR: Failed to start Docker infrastructure."
    echo "Make sure Docker is running and ports 4317, 4318, 16686 are free."
    exit 1
}
echo "Infrastructure ready."
echo ""

# Build the POC binary.
echo "Building tracing-poc..."
cargo build -p tracing-poc --manifest-path "${GRID_DIR}/Cargo.toml" 2>&1 | tail -3
echo ""

# Run the POC.
echo "Running tracing POC..."
echo ""
"${GRID_DIR}/target/debug/tracing-poc" "$@"
