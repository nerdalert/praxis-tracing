# OTel + Jaeger Kind Runbook

This is the exact observable workflow for the tracing fork. It deploys the
VCR-backed GLB demo to five Kind clusters, sends gateway traffic, and exposes
the live Jaeger and routing-observability UI endpoints.

## Image contract

The gateway must use the OTel-enabled Praxis image:

```text
ghcr.io/nerdalert/praxis-ai:otel-glb-demo
```

Do not substitute `ghcr.io/praxis-proxy/grid-ai-rollup:v0.1.3`; that released
image does not contain the OTel tracing instrumentation.

Supporting images:

```text
ghcr.io/praxis-proxy/grid-operator:v0.1.3
ghcr.io/neuralmagic/vllm-vcr:vllm0.23
```

## Start infrastructure and UI

From the repository root:

```bash
./scripts/run-tracing.sh
```

This starts Jaeger, the OTel Collector, and the observability UI. It does not
create Kind clusters yet.

The endpoints are:

| Component | URL |
|---|---|
| Observability UI | http://localhost:3001 |
| Jaeger UI | http://localhost:16686 |
| Jaeger API | http://localhost:16686/api |
| OTel Collector | http://localhost:4318 |

## Deploy the observable Kind environment

In a second terminal, from the repository root:

```bash
export GRID_REPO="$PWD/grid"
export GRID_XTASK_GATEWAY_IMAGE=ghcr.io/nerdalert/praxis-ai:otel-glb-demo
export GRID_XTASK_OPERATOR_IMAGE=ghcr.io/praxis-proxy/grid-operator:v0.1.3
export GRID_XTASK_VCR_IMAGE=ghcr.io/neuralmagic/vllm-vcr:vllm0.23
export GRID_XTASK_IMAGE_PULL_POLICY=Always

cd grid
cargo xtask env run-grid-glb-demo \
  --forge-config tests/e2e/topologies/grid-glb-demo/forge.yaml \
  --full
```

Do not pass `--teardown`. When this command completes, all five Kind clusters
remain available for inspection.

Connect the Collector to the Kind network and inject OTLP settings:

```bash
cd ..
./scripts/glb-otel-setup.sh
```

The setup script discovers the Collector container, connects it to
`grid-glb-demo-net`, injects `OTEL_EXPORTER_OTLP_ENDPOINT` and
`OTEL_SERVICE_NAME` into each gateway deployment, and waits for each rollout.

## Generate observable traffic

```bash
GTM_IP=$(kubectl get svc gtm-emulator -n grid-system \
  --context kind-grid-glb-gtm-emulator \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}')

curl -sk -X POST "https://${GTM_IP}:8443/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -H 'X-Edge-Session-Id: observe-1' \
  -d '{"model":"Qwen/Qwen3-0.6B","messages":[{"role":"user","content":"observe"}],"max_tokens":5}'
```

Inspect live data:

```bash
curl -s http://localhost:16686/api/services | python3 -m json.tool
curl -s http://localhost:3001/api/status | python3 -m json.tool
API_URL=http://localhost:3001 node routing-observability-ui/scripts/provider-status.js
./scripts/verify-glb-traces.sh
```

Expected Jaeger services include the OTel-enabled Praxis GTM, edge, and
provider gateway services. The UI should report live data and provide links to
the corresponding Jaeger traces.

## Verify the deployment

```bash
kubectl --context kind-grid-glb-east-edge -n grid-system get pods \
  -o custom-columns='NAME:.metadata.name,IMAGE:.spec.containers[0].image'
curl -s http://localhost:16686/api/services | python3 -m json.tool
```

Confirm that gateway pods use `ghcr.io/nerdalert/praxis-ai:otel-glb-demo`, not
the released `grid-ai-rollup:v0.1.3` image.

## Observation and cleanup

Leave the Docker services and Kind clusters running while inspecting the UI,
Jaeger, gateway logs, VCR logs, and provider state. Do not run teardown during
observation.

After observation:

```bash
./scripts/teardown-tracing.sh
./scripts/run-tracing.sh --teardown
```
