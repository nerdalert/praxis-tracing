#!/usr/bin/env bash
set -euo pipefail

EVIDENCE_DIR="${EVIDENCE_DIR:-$(dirname "$0")/../evidence}"
mkdir -p "$EVIDENCE_DIR"

GTM_IP=$(kubectl get svc gtm-emulator -n grid-system --context kind-grid-glb-gtm-emulator -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null)
RUN_ID="run-$(date +%Y%m%dT%H%M%S)"
RUN_START=$(date -u +%s)

echo "============================================"
echo "GLB Tracing Runtime Validation"
echo "Run ID: $RUN_ID"
echo "Start:  $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "GTM IP: $GTM_IP"
echo "Evidence: $EVIDENCE_DIR"
echo "============================================"
echo ""

send_request() {
  local session="$1"
  local label="$2"
  local result
  result=$(curl -sk -X POST "https://$GTM_IP:8443/v1/chat/completions" \
    -H 'Content-Type: application/json' \
    -H "X-Edge-Session-Id: ${RUN_ID}-${session}" \
    -d '{"model":"Qwen/Qwen3-0.6B","messages":[{"role":"user","content":"'"$label"'"}],"max_tokens":5}' \
    -w '\n%{http_code}' 2>&1)
  local code
  code=$(echo "$result" | tail -1)
  echo "  [$label] session=$session HTTP $code"
  return 0
}

query_traces() {
  local service="$1"
  local limit="${2:-5}"
  local lookback="${3:-5m}"
  curl -s "http://localhost:16686/api/traces?service=${service}&limit=${limit}&lookback=${lookback}" 2>/dev/null
}

scrape_metrics() {
  for ctx in grid-glb-east-provider grid-glb-west-provider; do
    echo "  $ctx:"
    for label in app.kubernetes.io/name=vllm-vcr; do
      local pod
      pod=$(kubectl get pods -n grid-system --context kind-$ctx -l "$label" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
      if [ -n "$pod" ]; then
        echo "    $pod:"
        kubectl exec "$pod" -n grid-system --context kind-$ctx -- wget -qO- http://127.0.0.1:8000/metrics 2>/dev/null | grep -E "vllm|kv_cache|queue" | head -5 || echo "      no matching metrics"
      fi
    done
  done
}

echo "=== Phase 1: Quick mode (single request) ==="
send_request "quick-1" "quick-validation"
sleep 2
echo "  Querying traces..."
query_traces "praxis-gtm-emulator" 1 "1m" > "$EVIDENCE_DIR/${RUN_ID}-quick-traces.json"
echo "  Saved: ${RUN_ID}-quick-traces.json"
echo ""

echo "=== Phase 2: Full mode (5 requests, varied sessions) ==="
for i in $(seq 1 5); do
  send_request "full-$i" "full-validation-$i"
done
sleep 3
echo "  Querying traces..."
query_traces "praxis-east-edge" 10 "2m" > "$EVIDENCE_DIR/${RUN_ID}-full-edge-traces.json"
query_traces "praxis-gtm-emulator" 10 "2m" > "$EVIDENCE_DIR/${RUN_ID}-full-gtm-traces.json"
echo "  Saved: ${RUN_ID}-full-*-traces.json"
echo ""

echo "=== Phase 3: Provider stress (20 concurrent requests) ==="
STRESS_START=$(date -u +%s)
for i in $(seq 1 20); do
  send_request "stress-$i" "stress-$i" &
done
wait
STRESS_END=$(date -u +%s)
echo "  Stress duration: $((STRESS_END - STRESS_START))s"
sleep 3
echo "  Querying post-stress traces..."
query_traces "praxis-east-edge" 25 "2m" > "$EVIDENCE_DIR/${RUN_ID}-stress-traces.json"
echo ""

echo "=== Phase 4: Metric scrape ==="
scrape_metrics > "$EVIDENCE_DIR/${RUN_ID}-metrics.txt" 2>&1
cat "$EVIDENCE_DIR/${RUN_ID}-metrics.txt"
echo ""

echo "=== Phase 5: Provider attribution ==="
python3 -c "
import json

with open('$EVIDENCE_DIR/${RUN_ID}-stress-traces.json') as f:
    data = json.load(f)

traces = data.get('data', [])
attribution = {}
services_seen = set()
for t in traces:
    procs = t.get('processes', {})
    for pid, proc in procs.items():
        services_seen.add(proc.get('serviceName', '?'))
    for s in t.get('spans', []):
        if s.get('operationName') == 'routing.select':
            tags = {tag['key']: tag['value'] for tag in s.get('tags', [])}
            cluster = tags.get('selected.cluster', 'unknown')
            attribution[cluster] = attribution.get(cluster, 0) + 1

print(f'Traces: {len(traces)}')
print(f'Services: {sorted(services_seen)}')
print('Attribution:')
for k, v in sorted(attribution.items()):
    print(f'  {k}: {v} requests')
" 2>/dev/null || echo "  Attribution analysis failed"
echo ""

echo "=== Phase 6: Recovery (5 post-stress requests) ==="
sleep 2
for i in $(seq 1 5); do
  send_request "recovery-$i" "recovery-$i"
done
sleep 2
query_traces "praxis-east-edge" 5 "1m" > "$EVIDENCE_DIR/${RUN_ID}-recovery-traces.json"
echo ""

echo "=== Phase 7: UI live mode verification ==="
# Kill any existing process on the test port
lsof -ti:18082 2>/dev/null | xargs kill 2>/dev/null
sleep 1
PORT=18082 node "$(dirname "$0")/../../routing-observability-ui/server.js" &
UI_PID=$!
sleep 2

echo "  Checking live API endpoints..."
for ep in status pools providers traces timeline; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:18082/api/$ep" 2>/dev/null)
  echo "  /api/$ep: HTTP $code"
done

# Save live provider state
curl -s "http://localhost:18082/api/providers" > "$EVIDENCE_DIR/${RUN_ID}-live-providers.json" 2>/dev/null
echo "  Saved: ${RUN_ID}-live-providers.json"

kill $UI_PID 2>/dev/null
wait $UI_PID 2>/dev/null || true
echo ""

RUN_END=$(date -u +%s)
echo "============================================"
echo "Validation complete"
echo "Run ID:   $RUN_ID"
echo "Duration: $((RUN_END - RUN_START))s"
echo "Evidence: $EVIDENCE_DIR"
echo "End:      $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "============================================"
