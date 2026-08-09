# GLB Tracing and Provider Pressure Visualization Demo

## What this demo proves

- GTM -> edge -> provider distributed tracing with real Jaeger spans
- W3C traceparent propagation across the edge/provider boundary
- GTM span emission via `otel_context` filter
- Provider pressure classification (normal / elevated / high / critical / unknown)
- Null-safe metric handling: missing data renders as unknown, never as a healthy zero
- Data-driven provider cards (not hardcoded to specific pools)
- Terminal and browser views agree on provider state

## What this demo does not prove

- Dynamic pressure from real traffic (GLB demo uses `noMetrics` scoring strategy; `grid_demo_queue_depth` is static 0.10)
- Complete GTM-to-backend trace chain with GTM intermediary spans (GTM now emits spans but is a proxy, not an application-level participant)
- EPP/VCR pressure-driven routing (separate companion demo)

## Architecture

```
Client
  |
  v
GTM (praxis-gtm-emulator)     [traced via otel_context filter]
  |
  +---> East Edge (praxis-east-edge)   [traced: SERVER, routing, CLIENT spans]
  |       |
  |       +---> East Provider (praxis-east-provider)  [traced: SERVER, validate spans]
  |       +---> East Provider Secondary               [eligible, not traced unless selected]
  |
  +---> West Edge (praxis-west-edge)   [traced: SERVER, routing, CLIENT spans]
          |
          +---> West Provider (praxis-west-provider)  [traced: SERVER, validate spans]
```

## Scoring strategy

The GLB demo runs with `noMetrics` scoring strategy. All provider scores are 0.0 and routing is by locality tier only. The overlay contains three candidates:

| Candidate | Rank | Tier | Stable ID |
|---|---|---|---|
| sim-east-provider | 0 | same_region | 84f799fe |
| sim-east-provider-secondary | 1 | same_region | eaf38b2d |
| sim-west-provider | 2 | cross_region | 9b5417da |

## Metric definitions

| Signal | Raw metric | Unit | Source | Status |
|---|---|---|---|---|
| Queue depth | `grid_demo_queue_depth` | normalized ratio [0,1] | mock provider | Static 0.10 |
| KV cache | — | — | — | Not exposed |
| Score | — | points | Grid overlay | 0.0 (noMetrics) |

## Pressure thresholds (visualization)

These are visualization thresholds, not production SLOs:

| Range | Level | Color |
|---|---|---|
| 0.00 - 0.49 | NORMAL | Green |
| 0.50 - 0.79 | ELEVATED | Yellow |
| 0.80 - 0.94 | HIGH | Orange |
| 0.95 - 1.00 | CRITICAL | Red |
| missing/stale | UNKNOWN | Gray |

## Running the demo

The authoritative operator workflow is documented in
[`glb-tracing-demo/readme.md`](../glb-tracing-demo/readme.md). It leaves Kind
running for observation and uses the OTel-enabled image
`ghcr.io/nerdalert/praxis-ai:otel-glb-demo`.

### Prerequisites

- Docker with buildx
- Kind (Kubernetes in Docker)
- kubectl

### Start the UI

```bash
cd routing-observability-ui
npm install
npm start
```

The UI is at http://localhost:8080

### Jaeger

Jaeger UI: http://localhost:16686

### Terminal status

```bash
cd routing-observability-ui
API_URL=http://localhost:8080 node scripts/provider-status.js
```

### Send test traffic

```bash
GTM_IP=$(kubectl get svc gtm-emulator -n grid-system --context kind-grid-glb-gtm-emulator -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
curl -sk -X POST "https://$GTM_IP:8443/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -H 'X-Edge-Session-Id: test-1' \
  -d '{"model":"Qwen/Qwen3-0.6B","messages":[{"role":"user","content":"test"}],"max_tokens":5}'
```

## Container image

```
praxis-ai:otel-glb-demo
```

Built from `Containerfile.otel` with `--features otel` enabled.

## Known limitations

- GTM is a TCP/TLS proxy; its span is a request-level wrapper, not application routing
- `grid_demo_queue_depth` is static and does not change with real load
- Overlay overlay revision is content-addressed; same candidates = same revision
- `noMetrics` strategy means all scores are 0.0
- Browser UI requires Jaeger on localhost:16686 for live mode; falls back to demo mode otherwise
