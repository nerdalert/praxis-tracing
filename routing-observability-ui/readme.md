# Grid Routing Observability UI

Real-time dashboard for the AI Grid two-pool routing scenario.
Shows pool scores, routing decisions, and trace timelines with
direct Jaeger links.

## Modes

| Mode | Badge | Source |
|------|-------|--------|
| **Live** | `LIVE` (green) | Jaeger API queries for real trace data |
| **Demo** | `MOCK DATA` (yellow) | Deterministic mock metrics with scenario controls |
| **Auto** | (detects) | Uses Live if Jaeger is reachable, Demo otherwise |

## Quick start

```console
cd routing-observability-ui
./scripts/start.sh
```

Open http://localhost:8080 in a browser.

For the real GLB tracing path, use the OTel-enabled Praxis AI fork:
<https://github.com/nerdalert/ai/tree/grid-otel-demo>. The released Praxis
image does not include the experimental tracing hooks used by that demo.

## Demo scenarios

In Demo mode, four scenarios are available:

| Scenario | Description |
|----------|-------------|
| Baseline | Pool A preferred (local advantage, low queue depth) |
| Pressure Failover | Pool A queue saturated, traffic shifts to Pool B |
| Recovery | Pool A queue recovered, traffic returns to Pool A |
| Pool A Degraded | Pool A unhealthy, all traffic to Pool B |

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/status` | GET | Current mode, Jaeger reachability |
| `/api/pools` | GET | Pool state with scores |
| `/api/traces?limit=N` | GET | Recent traces with Jaeger links |
| `/api/scenarios` | GET | Available demo scenarios |
| `/api/mode` | POST | Switch mode (`auto`, `live`, `demo`) |
| `/api/scenario/:name` | POST | Trigger demo scenario |

## Live llm-d / VCR metrics

Select `VCR/EPP` in the dashboard to read the running pool-metrics demo rather
than recorded evidence. With the two Kind clusters deployed, start the UI
from this directory:

```console
JAEGER_URL=http://localhost:16686 \
VCR_LIVE=true \
VCR_KUBECTL_CONTEXT_A=kind-grid-llmd-pm-pool-a \
VCR_KUBECTL_CONTEXT_B=kind-grid-llmd-pm-pool-b \
PORT=8080 node server.js
```

The server reads each pool's `llmd-epp-metrics` service through the Kubernetes
API proxy and reads the consumer gateway's current routing overlay ConfigMap.
It displays raw queue depth, normalized queue pressure, KV-cache utilization,
score, rank, scoring strategy, and overlay revision. Live reads are cached for
two seconds to match the dashboard refresh cadence. If the configured Kind
contexts are unavailable, `VCR_EVIDENCE_DIR` can provide a recorded fallback.

The live source expects the pool-metrics demo's default contexts and ConfigMap;
override `VCR_NAMESPACE`, `VCR_OVERLAY_CONFIGMAP`, or `VCR_QUEUE_CAPACITY` when
using a data-driven topology with different resource names or queue capacity.

## Scoring model

Matches the Grid scoring crate:

- Locality weight: 3.0 (Local=1.0, Remote=0.4)
- Queue depth weight: 5.0 (inverted: lower queue = higher score)
- Composite = locality_weight * locality + queue_weight * (1 - queue_depth)

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | UI server port |
| `JAEGER_URL` | `http://localhost:16686` | Jaeger query API base URL |

## Teardown

```console
./scripts/stop.sh
```

## Tests

```console
npm test
```
