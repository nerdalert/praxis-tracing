#!/usr/bin/env bash
# Full tracing demo: infrastructure + synthetic POC + real Praxis + UI.
#
# Usage:
#   ./scripts/run-full-tracing-demo.sh
#   ./scripts/run-full-tracing-demo.sh --teardown
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== Full Tracing Demo ==="
echo ""

if [[ "${1:-}" == "--teardown" ]]; then
    "${SCRIPT_DIR}/run-real-praxis-tracing.sh" --teardown 2>/dev/null || true
    "${SCRIPT_DIR}/run-tracing.sh" --teardown 2>/dev/null || true
    echo "All services stopped."
    exit 0
fi

# Step 1: Infrastructure + synthetic POC + UI
echo "[1/3] Starting infrastructure + synthetic POC + UI..."
"${SCRIPT_DIR}/run-tracing.sh" --poc quick || {
    echo "WARNING: Synthetic POC step had issues (continuing anyway)"
}

echo ""

# Step 2: Real Praxis topology (if binary available)
ROLLUP_DIR="${ROLLUP_DIR:-${ROOT_DIR}/components/ai}"
PRAXIS_BIN="${ROLLUP_DIR}/target/debug/praxis-ai-proxy"

if [[ -x "$PRAXIS_BIN" ]]; then
    echo "[2/3] Starting real Praxis topology..."
    "${SCRIPT_DIR}/run-real-praxis-tracing.sh" || {
        echo "WARNING: Real Praxis topology had issues (check evidence/praxis-server.log)"
    }
else
    echo "[2/3] Skipping real Praxis (binary not found at $PRAXIS_BIN)"
    echo "  Build with: cargo build -p praxis-ai-proxy --features otel"
fi

echo ""

# Step 3: Summary
echo "[3/3] Evidence summary..."
"${SCRIPT_DIR}/evidence-summary.sh"

echo ""
echo "=== Demo Ready ==="
echo "  Observability UI: http://localhost:${UI_PORT:-3001}"
echo "  Jaeger UI:        http://localhost:16686"
echo ""
echo "  Stop all: $0 --teardown"
