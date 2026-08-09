#!/usr/bin/env bash
# Verify multi-hop GLB traces in Jaeger.
# Checks for traces that span multiple services (GTM→Edge→Provider→Backend).
set -euo pipefail

JAEGER_URL="${JAEGER_URL:-http://localhost:16686}"
EXPECTED_SERVICES="${EXPECTED_SERVICES:-praxis-gtm-emulator,praxis-east-edge,praxis-west-edge,praxis-east-provider,praxis-west-provider}"
MIN_SPANS="${MIN_SPANS:-2}"
POLL_TIMEOUT="${POLL_TIMEOUT:-60}"

echo "=== GLB Trace Verification ==="
echo "Jaeger: ${JAEGER_URL}"
echo "Expected services: ${EXPECTED_SERVICES}"
echo ""

# Step 1: Check which services are reporting to Jaeger.
echo "--- Checking registered services ---"
SERVICES_JSON=$(curl -sf "${JAEGER_URL}/api/services" 2>/dev/null || echo '{"data":[]}')
echo "${SERVICES_JSON}" | python3 -c "
import json, sys
data = json.load(sys.stdin)
services = data.get('data', [])
print(f'  Services in Jaeger: {len(services)}')
for s in sorted(services):
    if s != 'jaeger-query':
        print(f'    - {s}')
"

# Step 2: For each expected praxis service, look for traces.
echo ""
echo "--- Checking traces per service ---"
IFS=',' read -ra SVC_LIST <<< "${EXPECTED_SERVICES}"
FOUND_SERVICES=0
TOTAL_TRACES=0

for svc in "${SVC_LIST[@]}"; do
    TRACES_JSON=$(curl -sf "${JAEGER_URL}/api/traces?service=${svc}&limit=5&lookback=1h" 2>/dev/null || echo '{"data":[]}')
    TRACE_COUNT=$(echo "${TRACES_JSON}" | python3 -c "
import json, sys
data = json.load(sys.stdin)
traces = data.get('data', [])
print(len(traces))
")
    if [[ "${TRACE_COUNT}" -gt 0 ]]; then
        echo "  ${svc}: ${TRACE_COUNT} traces FOUND"
        FOUND_SERVICES=$((FOUND_SERVICES + 1))
        TOTAL_TRACES=$((TOTAL_TRACES + TRACE_COUNT))
    else
        echo "  ${svc}: no traces"
    fi
done

echo ""
echo "  Services with traces: ${FOUND_SERVICES}/${#SVC_LIST[@]}"
echo "  Total traces found: ${TOTAL_TRACES}"

# Step 3: Look for multi-service traces (the real multi-hop verification).
echo ""
echo "--- Multi-hop trace analysis ---"

# Get traces from any service that has them.
MULTIHOP_COUNT=0
for svc in "${SVC_LIST[@]}"; do
    TRACES_JSON=$(curl -sf "${JAEGER_URL}/api/traces?service=${svc}&limit=10&lookback=1h" 2>/dev/null || echo '{"data":[]}')

    echo "${TRACES_JSON}" | python3 -c "
import json, sys

data = json.load(sys.stdin)
traces = data.get('data', [])
multihop = 0

for trace in traces:
    processes = trace.get('processes', {})
    service_names = set()
    for pid, proc in processes.items():
        sname = proc.get('serviceName', '')
        if sname and sname != 'jaeger-query':
            service_names.add(sname)

    spans = trace.get('spans', [])
    span_kinds = {}
    for span in spans:
        kind = 'unknown'
        for tag in span.get('tags', []):
            if tag.get('key') == 'span.kind':
                kind = tag.get('value', 'unknown')
        svc = processes.get(span.get('processID', ''), {}).get('serviceName', '?')
        span_kinds.setdefault(svc, []).append(kind)

    if len(service_names) >= 2:
        multihop += 1
        trace_id = trace.get('traceID', '?')
        print(f'  MULTI-HOP trace {trace_id}:')
        print(f'    Services: {sorted(service_names)}')
        print(f'    Span count: {len(spans)}')
        for svc_name in sorted(service_names):
            kinds = span_kinds.get(svc_name, [])
            print(f'      {svc_name}: {kinds}')

print(f'__MULTIHOP_COUNT={multihop}')
" 2>/dev/null | while IFS= read -r line; do
        if [[ "${line}" == __MULTIHOP_COUNT=* ]]; then
            count="${line#__MULTIHOP_COUNT=}"
            MULTIHOP_COUNT=$((MULTIHOP_COUNT + count))
        else
            echo "${line}"
        fi
    done
done

# Step 4: Verify span hierarchy within traces.
echo ""
echo "--- Span hierarchy verification ---"
for svc in "${SVC_LIST[@]}"; do
    TRACES_JSON=$(curl -sf "${JAEGER_URL}/api/traces?service=${svc}&limit=3&lookback=1h" 2>/dev/null || echo '{"data":[]}')

    echo "${TRACES_JSON}" | python3 -c "
import json, sys

data = json.load(sys.stdin)
traces = data.get('data', [])

for trace in traces:
    spans = trace.get('spans', [])
    processes = trace.get('processes', {})
    trace_id = trace.get('traceID', '?')[:16]

    server_spans = []
    client_spans = []
    internal_spans = []

    for span in spans:
        kind = 'unknown'
        for tag in span.get('tags', []):
            if tag.get('key') == 'span.kind':
                kind = tag.get('value', 'unknown')
        svc_name = processes.get(span.get('processID', ''), {}).get('serviceName', '?')

        if kind == 'server':
            server_spans.append((svc_name, span.get('operationName', '?')))
        elif kind == 'client':
            client_spans.append((svc_name, span.get('operationName', '?')))
        elif kind == 'internal':
            internal_spans.append((svc_name, span.get('operationName', '?')))

    if len(spans) >= 2:
        print(f'  Trace {trace_id}... ({len(spans)} spans):')
        for svc, op in server_spans:
            print(f'    SERVER: {svc}/{op}')
        for svc, op in internal_spans:
            print(f'    INTERNAL: {svc}/{op}')
        for svc, op in client_spans:
            print(f'    CLIENT: {svc}/{op}')

        has_server = len(server_spans) > 0
        has_client = len(client_spans) > 0
        has_parent_child = any(
            any(ref.get('refType') == 'CHILD_OF' for ref in span.get('references', []))
            for span in spans
        )
        print(f'    server={has_server} client={has_client} parent-child={has_parent_child}')
" 2>/dev/null | head -60
    break  # Only need to check one service for hierarchy
done

echo ""
echo "=== Verification complete ==="
