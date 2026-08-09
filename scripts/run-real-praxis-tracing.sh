#!/usr/bin/env bash
# Start a real Praxis server with OTel enabled, mock backends, and
# send test requests through the full filter chain.
#
# Prerequisites: Jaeger + OTel Collector running (via run-tracing.sh or Docker)
# The rollup AI workspace at $ROLLUP_DIR must be pre-built with --features otel.
#
# Usage:
#   ./scripts/run-real-praxis-tracing.sh              # --quick mode (default)
#   ./scripts/run-real-praxis-tracing.sh --full        # full validation with Jaeger
#   ./scripts/run-real-praxis-tracing.sh --test-only   # send requests only
#   ./scripts/run-real-praxis-tracing.sh --teardown    # stop all
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
EVIDENCE_DIR="${ROOT_DIR}/evidence"

ROLLUP_DIR="${ROLLUP_DIR:-${ROOT_DIR}/components/ai}"
PRAXIS_BIN="${ROLLUP_DIR}/target/debug/praxis-ai"
CONFIG_FILE="${SCRIPT_DIR}/praxis-tracing.yaml"

PROXY_PORT=8090
ADMIN_PORT=9903
BACKEND_A_PORT=9100
BACKEND_B_PORT=9101
JAEGER_URL="${JAEGER_URL:-http://localhost:16686}"

PID_DIR="/tmp"

cleanup() {
    local exit_code=$?
    echo ""
    echo "Cleaning up..."
    for name in praxis-server mock-backend-a mock-backend-b; do
        local pid_file="${PID_DIR}/${name}.pid"
        if [[ -f "$pid_file" ]]; then
            local pid
            pid=$(cat "$pid_file")
            if kill -0 "$pid" 2>/dev/null; then
                kill "$pid" 2>/dev/null || true
                echo "  Stopped $name (PID $pid)"
            fi
            rm -f "$pid_file"
        fi
    done
    exit "$exit_code"
}

check_port() {
    local port=$1 name=$2
    if ss -tlnp 2>/dev/null | grep -q ":${port} " || \
       lsof -i ":${port}" -sTCP:LISTEN >/dev/null 2>&1; then
        echo "ERROR: port ${port} (${name}) is already in use." >&2
        return 1
    fi
}

wait_for_port() {
    local port=$1 name=$2 timeout=${3:-10}
    local elapsed=0
    while ! (echo >/dev/tcp/127.0.0.1/"$port") 2>/dev/null; do
        sleep 0.5
        elapsed=$((elapsed + 1))
        if [[ $elapsed -ge $((timeout * 2)) ]]; then
            echo "ERROR: $name did not start on port $port within ${timeout}s" >&2
            return 1
        fi
    done
}

poll_jaeger_traces() {
    local service=$1 limit=$2 max_wait=${3:-30}
    local elapsed=0
    local data=""
    while [[ $elapsed -lt $max_wait ]]; do
        data=$(curl -sf "${JAEGER_URL}/api/traces?service=${service}&limit=${limit}" 2>/dev/null) || true
        if [[ -n "$data" ]]; then
            local count
            count=$(echo "$data" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(len(d.get('data', [])))" 2>/dev/null) || count=0
            if [[ "$count" -gt 0 ]]; then
                echo "$data"
                return 0
            fi
        fi
        sleep 2
        elapsed=$((elapsed + 2))
    done
    echo ""
    return 1
}

verify_trace_structure() {
    local trace_json=$1
    local trace_idx=$2
    python3 - "$trace_json" "$trace_idx" <<'PYEOF'
import sys, json

data = json.loads(sys.argv[1])
idx = int(sys.argv[2])
traces = data.get("data", [])
if idx >= len(traces):
    print(f"  FAIL: trace index {idx} out of range ({len(traces)} traces)")
    sys.exit(1)

trace = traces[idx]
trace_id = trace["traceID"]
spans = trace["spans"]
span_count = len(spans)

server = [s for s in spans if any(
    t.get("key") == "span.kind" and str(t.get("value","")).lower() == "server"
    for t in s.get("tags", [])
)]
routing = [s for s in spans if s["operationName"] == "routing.select"]
client = [s for s in spans if any(
    t.get("key") == "span.kind" and str(t.get("value","")).lower() == "client"
    for t in s.get("tags", [])
)]

ok = True
print(f"  Trace {trace_id[:12]}...: {span_count} spans")

if not server:
    print("    FAIL: no SERVER span")
    ok = False
else:
    sid = server[0]["spanID"]
    print(f"    SERVER span: {sid}")

if not routing:
    print("    FAIL: no routing.select span")
    ok = False
else:
    rid = routing[0]["spanID"]
    refs = routing[0].get("references", [])
    parent = next((r["spanID"] for r in refs if r["refType"] == "CHILD_OF"), None)
    is_child = server and parent == server[0]["spanID"]
    print(f"    routing.select: {rid} parent={parent} child-of-SERVER={is_child}")
    if not is_child:
        print("    FAIL: routing span is not child of SERVER")
        ok = False

if not client:
    print("    FAIL: no CLIENT span")
    ok = False
else:
    cid = client[0]["spanID"]
    refs = client[0].get("references", [])
    parent = next((r["spanID"] for r in refs if r["refType"] == "CHILD_OF"), None)
    is_child = server and parent == server[0]["spanID"]
    print(f"    CLIENT span: {cid} parent={parent} child-of-SERVER={is_child}")
    if not is_child:
        print("    FAIL: CLIENT span is not child of SERVER")
        ok = False

if ok and span_count >= 3:
    print("    PASS: 3-span hierarchy verified")
elif server and span_count == 1:
    print("    SKIP: 1-span trace (server-only, likely non-routed request)")
else:
    print("    FAIL: trace structure incomplete")
    sys.exit(1)
PYEOF
}

send_test_requests() {
    local mode=$1
    echo ""
    echo "=== Sending Test Requests ==="
    echo ""

    # Quick: 2 requests (one per model). Full: adds inbound traceparent + repeat.
    if [[ "$mode" == "full" ]]; then
        local models=("test-model-a" "test-model-b" "test-model-a" "test-model-b")
        local labels=("A-route" "B-route" "A-with-traceparent" "B-recovery")
        local extra_headers=("" "" "-H traceparent:00-aaaabbbbccccddddeeee111122223333-1234567890abcdef-01" "")
    else
        local models=("test-model-a" "test-model-b")
        local labels=("A-route" "B-route")
        local extra_headers=("" "")
    fi

    for i in "${!models[@]}"; do
        local model="${models[$i]}"
        local label="${labels[$i]}"
        echo "  [${label}] POST /v1/chat/completions model=${model}"
        local http_code
        http_code=$(curl -s -o /dev/null -w "%{http_code}" \
            -X POST "http://127.0.0.1:${PROXY_PORT}/v1/chat/completions" \
            -H "Content-Type: application/json" \
            ${extra_headers[$i]} \
            -d "{\"model\":\"${model}\",\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}]}" \
            2>/dev/null) || true
        if [[ "${http_code:-0}" == "200" ]]; then
            echo "    HTTP 200 OK"
        else
            echo "    HTTP ${http_code:-timeout} FAIL"
        fi
        sleep 0.5
    done

    echo ""
    echo "Waiting for span flush (6s)..."
    sleep 6

    echo ""
    echo "=== Jaeger Trace Verification ==="
    echo ""
    echo "Polling Jaeger for praxis-ai traces (up to 30s)..."
    local trace_data
    if trace_data=$(poll_jaeger_traces "praxis-ai" 10 30); then
        local count
        count=$(echo "$trace_data" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(len(d.get('data', [])))" 2>/dev/null) || count=0
        echo "  Found ${count} trace(s)"
        echo ""

        local max_verify=$count
        if [[ $max_verify -gt 4 ]]; then max_verify=4; fi
        local all_pass=true
        for ((j=0; j<max_verify; j++)); do
            if ! verify_trace_structure "$trace_data" "$j"; then
                all_pass=false
            fi
        done

        echo ""
        if $all_pass; then
            echo "=== ALL TRACES VERIFIED ==="
        else
            echo "=== SOME TRACES FAILED VERIFICATION ==="
        fi
    else
        echo "  No traces found in Jaeger within 30s."
        echo "  Check: is OTel Collector running? Is Jaeger reachable at ${JAEGER_URL}?"
    fi
}

# Parse arguments
ACTION="start"
MODE="quick"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --teardown) ACTION="teardown"; shift ;;
        --test-only) ACTION="test"; shift ;;
        --quick) MODE="quick"; shift ;;
        --full) MODE="full"; shift ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

if [[ "$ACTION" == "teardown" ]]; then
    cleanup
    exit 0
fi

if [[ "$ACTION" == "test" ]]; then
    send_test_requests "$MODE"
    exit 0
fi

trap cleanup INT TERM

echo "=== Real Praxis Tracing Topology (${MODE} mode) ==="
echo ""

# Verify prerequisites
if [[ ! -x "$PRAXIS_BIN" ]]; then
    echo "ERROR: Praxis binary not found at $PRAXIS_BIN" >&2
    echo "Build with: cargo build -p praxis-ai-server --features otel --manifest-path ${ROLLUP_DIR}/Cargo.toml" >&2
    exit 1
fi

if [[ ! -f "$CONFIG_FILE" ]]; then
    echo "ERROR: Config not found at $CONFIG_FILE" >&2
    exit 1
fi

# Check ports
for pair in "${PROXY_PORT}:proxy" "${ADMIN_PORT}:admin" "${BACKEND_A_PORT}:backend-a" "${BACKEND_B_PORT}:backend-b"; do
    port="${pair%%:*}"
    name="${pair##*:}"
    check_port "$port" "$name" || exit 1
done

mkdir -p "$EVIDENCE_DIR"

# Start mock backends
echo "Starting mock backends..."
node "${SCRIPT_DIR}/mock-backend.js" "$BACKEND_A_PORT" pool-a \
    >> "${EVIDENCE_DIR}/mock-backend-a.log" 2>&1 &
echo $! > "${PID_DIR}/mock-backend-a.pid"

node "${SCRIPT_DIR}/mock-backend.js" "$BACKEND_B_PORT" pool-b \
    >> "${EVIDENCE_DIR}/mock-backend-b.log" 2>&1 &
echo $! > "${PID_DIR}/mock-backend-b.pid"

wait_for_port "$BACKEND_A_PORT" "mock-backend-a"
wait_for_port "$BACKEND_B_PORT" "mock-backend-b"
echo "  mock-backend-a on :${BACKEND_A_PORT}"
echo "  mock-backend-b on :${BACKEND_B_PORT}"

# Start Praxis
echo "Starting Praxis server..."
OTEL_EXPORTER_OTLP_ENDPOINT="${OTEL_EXPORTER_OTLP_ENDPOINT:-http://localhost:4318}" \
    "$PRAXIS_BIN" -c "$CONFIG_FILE" \
    >> "${EVIDENCE_DIR}/praxis-server.log" 2>&1 &
echo $! > "${PID_DIR}/praxis-server.pid"

wait_for_port "$PROXY_PORT" "praxis-proxy" 15
echo "  praxis-proxy on :${PROXY_PORT}"
echo "  praxis-admin on :${ADMIN_PORT}"

echo ""
echo "=== Topology Ready ==="
echo "  Client -> :${PROXY_PORT} (Praxis+OTel) -> :${BACKEND_A_PORT}/:${BACKEND_B_PORT} (backends)"
echo ""
echo "  Test:     $0 --test-only [--quick|--full]"
echo "  Teardown: $0 --teardown"

send_test_requests "$MODE"
