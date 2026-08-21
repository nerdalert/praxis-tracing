#!/usr/bin/env bash
# Unified tracing orchestration for Grid + Praxis AI.
#
# Starts Jaeger + OTel Collector infrastructure, optionally runs the
# synthetic tracing POC, and launches the observability UI.
#
# Usage:
#   ./scripts/run-tracing.sh              # infrastructure + UI only
#   ./scripts/run-tracing.sh --poc quick   # + run POC in quick mode
#   ./scripts/run-tracing.sh --poc full    # + run POC with full scenarios
#   ./scripts/run-tracing.sh --teardown    # stop everything
#
# Environment:
#   UI_PORT            UI server port (default: 3001)
#   JAEGER_URL         Jaeger endpoint (default: http://localhost:16686)
#   OTEL_ENDPOINT      OTel collector endpoint (default: http://localhost:4318)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/compose.sh"
ROOT_DIR="$(dirname "${SCRIPT_DIR}")"
GRID_DIR="${ROOT_DIR}/components/grid"
POC_DIR="${GRID_DIR}/tracing-poc"
UI_DIR="${ROOT_DIR}/routing-observability-ui"
COMPOSE_FILE="${POC_DIR}/docker/docker-compose.yaml"

UI_PORT="${UI_PORT:-3001}"
JAEGER_URL="${JAEGER_URL:-http://localhost:16686}"
JAEGER_UI_URL="${JAEGER_UI_URL:-${JAEGER_URL}}"
VCR_LIVE="${VCR_LIVE:-false}"
VCR_KUBECTL_CONTEXT_A="${VCR_KUBECTL_CONTEXT_A:-}"
VCR_KUBECTL_CONTEXT_B="${VCR_KUBECTL_CONTEXT_B:-}"
VCR_NAMESPACE="${VCR_NAMESPACE:-grid-system}"
VCR_OVERLAY_CONFIGMAP="${VCR_OVERLAY_CONFIGMAP:-}"
VCR_QUEUE_CAPACITY="${VCR_QUEUE_CAPACITY:-4}"
TRACING_UI_TOKEN_RATE_LIMIT="${TRACING_UI_TOKEN_RATE_LIMIT:-false}"
TRACING_UI_FIXTURE_MODE="${TRACING_UI_FIXTURE_MODE:-}"
TRACING_UI_TOKEN_CONSUMER_A_URL="${TRACING_UI_TOKEN_CONSUMER_A_URL:-}"
TRACING_UI_TOKEN_CONSUMER_B_URL="${TRACING_UI_TOKEN_CONSUMER_B_URL:-}"
TRACING_UI_TOKEN_USERNAME="${TRACING_UI_TOKEN_USERNAME:-alice}"
TRACING_UI_TOKEN_PASSWORD_FILE="${TRACING_UI_TOKEN_PASSWORD_FILE:-}"
TRACING_UI_TOKEN_MODEL="${TRACING_UI_TOKEN_MODEL:-Qwen/Qwen3-0.6B}"
TRACING_UI_TOKEN_LIMIT="${TRACING_UI_TOKEN_LIMIT:-60}"
TRACING_UI_TOKEN_WINDOW_SECONDS="${TRACING_UI_TOKEN_WINDOW_SECONDS:-60}"
TRACING_UI_TOKEN_BACKEND_LABEL="${TRACING_UI_TOKEN_BACKEND_LABEL:-vllm-vcr}"

POC_MODE=""
TEARDOWN=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --poc)
            POC_MODE="${2:-quick}"
            shift 2 || shift
            ;;
        --teardown)
            TEARDOWN=true
            shift
            ;;
        *)
            echo "Unknown option: $1" >&2
            exit 1
            ;;
    esac
done

if "${TEARDOWN}"; then
    echo "=== Teardown ==="
    echo ""
    # Stop UI if running
    if [ -f "${ROOT_DIR}/.ui.pid" ]; then
        UI_PID="$(cat "${ROOT_DIR}/.ui.pid")"
        if kill -0 "${UI_PID}" 2>/dev/null; then
            echo "Stopping UI (PID ${UI_PID})..."
            kill "${UI_PID}" 2>/dev/null || true
        fi
        rm -f "${ROOT_DIR}/.ui.pid"
    fi
    # Stop Docker infrastructure
    echo "Stopping Jaeger + OTel Collector..."
    compose -f "${COMPOSE_FILE}" down -v 2>/dev/null || true
    echo "Done."
    exit 0
fi

echo "=== Grid Tracing Stack ==="
echo ""

# Start infrastructure
echo "Starting Jaeger + OTel Collector..."
compose -f "${COMPOSE_FILE}" up -d --wait 2>/dev/null || {
    echo "ERROR: Failed to start Docker infrastructure."
    echo "Make sure Docker is running and ports 4317, 4318, 16686 are free."
    exit 1
}
echo "Infrastructure ready."
echo ""

# Run POC if requested
if [[ -n "${POC_MODE}" ]]; then
    echo "Building and running tracing POC (mode: ${POC_MODE})..."
    cargo build -p tracing-poc --manifest-path "${GRID_DIR}/Cargo.toml" 2>&1 | tail -3
    echo ""
    "${GRID_DIR}/target/debug/tracing-poc" --mode "${POC_MODE}"
    echo ""
fi

# Start UI
echo "Starting Observability UI on port ${UI_PORT}..."
cd "${UI_DIR}"
nohup setsid env \
  PORT="${UI_PORT}" \
  JAEGER_URL="${JAEGER_URL}" \
  JAEGER_UI_URL="${JAEGER_UI_URL}" \
  VCR_LIVE="${VCR_LIVE}" \
  VCR_KUBECTL_CONTEXT_A="${VCR_KUBECTL_CONTEXT_A}" \
  VCR_KUBECTL_CONTEXT_B="${VCR_KUBECTL_CONTEXT_B}" \
  VCR_NAMESPACE="${VCR_NAMESPACE}" \
  VCR_OVERLAY_CONFIGMAP="${VCR_OVERLAY_CONFIGMAP}" \
  VCR_QUEUE_CAPACITY="${VCR_QUEUE_CAPACITY}" \
  TRACING_UI_TOKEN_RATE_LIMIT="${TRACING_UI_TOKEN_RATE_LIMIT}" \
  TRACING_UI_FIXTURE_MODE="${TRACING_UI_FIXTURE_MODE}" \
  TRACING_UI_TOKEN_CONSUMER_A_URL="${TRACING_UI_TOKEN_CONSUMER_A_URL}" \
  TRACING_UI_TOKEN_CONSUMER_B_URL="${TRACING_UI_TOKEN_CONSUMER_B_URL}" \
  TRACING_UI_TOKEN_USERNAME="${TRACING_UI_TOKEN_USERNAME}" \
  TRACING_UI_TOKEN_PASSWORD_FILE="${TRACING_UI_TOKEN_PASSWORD_FILE}" \
  TRACING_UI_TOKEN_MODEL="${TRACING_UI_TOKEN_MODEL}" \
  TRACING_UI_TOKEN_LIMIT="${TRACING_UI_TOKEN_LIMIT}" \
  TRACING_UI_TOKEN_WINDOW_SECONDS="${TRACING_UI_TOKEN_WINDOW_SECONDS}" \
  TRACING_UI_TOKEN_BACKEND_LABEL="${TRACING_UI_TOKEN_BACKEND_LABEL}" \
  node server.js > "${ROOT_DIR}/.ui.log" 2>&1 &
UI_PID=$!
echo "${UI_PID}" > "${ROOT_DIR}/.ui.pid"

sleep 1
if kill -0 "${UI_PID}" 2>/dev/null; then
    echo ""
    echo "=== Ready ==="
    echo "  Jaeger UI:        ${JAEGER_URL}"
    echo "  Observability UI: http://localhost:${UI_PORT}"
    echo "  OTel Collector:   http://localhost:4318"
    echo ""
    echo "To stop: $0 --teardown"
else
    echo "WARNING: UI server did not start (port ${UI_PORT} may be in use)."
    echo "Try: UI_PORT=8081 $0"
fi
