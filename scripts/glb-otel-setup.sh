#!/usr/bin/env bash
# Connect OTel Collector to Kind network and inject OTEL env vars into
# all Praxis gateway deployments across GLB demo clusters.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/compose.sh"

COMPOSE_PROJECT="${COMPOSE_PROJECT:-docker}"
COMPOSE_SERVICE="${COMPOSE_SERVICE:-otel-collector}"
KIND_NETWORK="${KIND_NETWORK:-grid-glb-demo-net}"
OTLP_PORT="${OTLP_PORT:-4318}"
RUN_ID="${RUN_ID:-$(date -u +%Y%m%d-%H%M%S)}"

echo "=== GLB OTel Setup ==="
echo "Run ID: ${RUN_ID}"

# Step 1: Resolve the collector container name from Compose.
COLLECTOR_CONTAINER=$(compose -p "${COMPOSE_PROJECT}" ps -q "${COMPOSE_SERVICE}" 2>/dev/null || true)
if [[ -z "${COLLECTOR_CONTAINER}" ]]; then
    COLLECTOR_CONTAINER=$(docker ps --filter "label=com.docker.compose.service=${COMPOSE_SERVICE}" \
        --filter "label=com.docker.compose.project=${COMPOSE_PROJECT}" -q 2>/dev/null | head -1)
fi
if [[ -z "${COLLECTOR_CONTAINER}" ]]; then
    COLLECTOR_CONTAINER="${OTEL_COLLECTOR_CONTAINER:-docker-otel-collector-1}"
    echo "WARNING: Could not resolve collector via Compose. Falling back to: ${COLLECTOR_CONTAINER}"
fi

COLLECTOR_NAME=$(docker inspect "${COLLECTOR_CONTAINER}" --format='{{.Name}}' 2>/dev/null | sed 's|^/||')
echo "Collector container: ${COLLECTOR_NAME} (${COLLECTOR_CONTAINER})"

# Step 2: Connect OTel Collector to the Kind network (idempotent).
if ! docker network inspect "${KIND_NETWORK}" >/dev/null 2>&1; then
    echo "ERROR: Kind network '${KIND_NETWORK}' not found. Are Kind clusters running?"
    exit 1
fi

if docker inspect "${COLLECTOR_CONTAINER}" --format '{{json .NetworkSettings.Networks}}' 2>/dev/null \
    | grep -q "\"${KIND_NETWORK}\""; then
    echo "OTel Collector already on ${KIND_NETWORK} network"
else
    echo "Connecting ${COLLECTOR_NAME} to ${KIND_NETWORK} network..."
    docker network connect "${KIND_NETWORK}" "${COLLECTOR_CONTAINER}"
fi

# Step 3: Get the Collector's IP on the Kind network.
COLLECTOR_IP=$(docker inspect "${COLLECTOR_CONTAINER}" \
    --format "{{(index .NetworkSettings.Networks \"${KIND_NETWORK}\").IPAddress}}")

if [[ -z "${COLLECTOR_IP}" ]]; then
    echo "ERROR: Could not determine Collector IP on ${KIND_NETWORK}"
    exit 1
fi

OTLP_ENDPOINT="http://${COLLECTOR_IP}:${OTLP_PORT}"
echo "OTel Collector IP on Kind network: ${COLLECTOR_IP}"
echo "OTLP endpoint: ${OTLP_ENDPOINT}"

# Step 4: Inject env vars into each Praxis gateway deployment.
CLUSTERS=(
    "grid-glb-east-provider:provider-gateway:praxis-east-provider"
    "grid-glb-west-provider:provider-gateway:praxis-west-provider"
    "grid-glb-east-edge:edge-gateway:praxis-east-edge"
    "grid-glb-west-edge:edge-gateway:praxis-west-edge"
    "grid-glb-gtm-emulator:gtm-emulator:praxis-gtm-emulator"
)

for entry in "${CLUSTERS[@]}"; do
    IFS=: read -r cluster deployment svc_name <<< "${entry}"
    ctx="kind-${cluster}"
    echo ""
    echo "--- ${ctx} / ${deployment} ---"

    if ! kubectl --context "${ctx}" -n grid-system get deployment "${deployment}" >/dev/null 2>&1; then
        echo "  SKIP: deployment not found"
        continue
    fi

    kubectl --context "${ctx}" -n grid-system set env "deployment/${deployment}" \
        "OTEL_EXPORTER_OTLP_ENDPOINT=${OTLP_ENDPOINT}" \
        "OTEL_SERVICE_NAME=${svc_name}" \
        "OTEL_RESOURCE_ATTRIBUTES=demo.run_id=${RUN_ID}" \
        --containers=praxis

    echo "  Waiting for rollout..."
    kubectl --context "${ctx}" -n grid-system rollout status "deployment/${deployment}" --timeout=120s
    echo "  OK"
done

echo ""
echo "=== OTel env vars injected into all gateway deployments ==="
echo "Run ID: ${RUN_ID}"
echo "OTLP endpoint: ${OTLP_ENDPOINT}"
echo ""
echo "Verify with:"
echo "  curl -s http://localhost:16686/api/services | python3 -m json.tool"
