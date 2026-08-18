# Grid Routing Observability UI

Real-time dashboard for the AI Grid two-pool routing scenario.
Shows pool scores, routing decisions, and trace timelines with
direct Jaeger links.

## Evidence status

The dashboard does not ask users to choose between implementation modes. It
reports the evidence available for the selected environment:

- `LIVE EVIDENCE` means the values came from reachable Jaeger/Grid services.
- `LIVE EPP METRICS` means the llm-d/VCR provider cards include a current EPP
  sample. This is the only view that presents queue and KV pressure metrics.
- `SIMULATION ENABLED` means local fixtures are enabled explicitly for a
  presentation; every generated request is labeled simulated.
- `UNAVAILABLE` means the required live source could not be read. The UI does
  not invent provider, score, metric, or trace values.

Simulation is opt-in. For local synthetic fixtures only, start with:
For local synthetic fixtures only, start with:

```console
ALLOW_SIMULATION=true ./scripts/start.sh
```

Synthetic requests, presenter scripts, and replay are labeled `SIMULATED` and
are not runtime evidence.

## Quick start

```console
cd routing-observability-ui
./scripts/start.sh
```

Open http://localhost:3001 in a browser.

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

The request-first v2 contract is under `/api/v1`:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/capabilities` | GET | Detected environment and capability states |
| `/api/v1/requests` | GET | Normalized, filtered, cursor-paginated requests |
| `/api/v1/requests/:requestId` | GET | Request detail, provenance, and replay safety |
| `/api/v1/events/stream` | GET | Server-sent request/generation/replay events |
| `/api/v1/replays` | POST | Queue a synthetic-only replay |
| `/api/load/status` | GET | Live llm-d sustained-load capability and job state |
| `/api/load` | POST | Start a bounded real llm-d load job |
| `/api/load/cancel` | POST | Stop the active llm-d load job |

Implementation and checkpoint notes are in
[`../docs/v2-implementation.md`](../docs/v2-implementation.md).

## Live llm-d / VCR metrics

Select `llm-d/EPP` in the dashboard to read the running pool-metrics demo rather
than recorded evidence. With the two Kind clusters deployed, start the UI
from this directory:

```console
JAEGER_URL=http://localhost:16686 \
VCR_LIVE=true \
VCR_KUBECTL_CONTEXT_A=kind-grid-llmd-pm-pool-a \
VCR_KUBECTL_CONTEXT_B=kind-grid-llmd-pm-pool-b \
PORT=3001 node server.js
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

## Opt-in token-rate-limit demo

The quota view is disabled by default and does not request quota-specific data.
Enable the capability explicitly with:

```console
TRACING_UI_TOKEN_RATE_LIMIT=true node server.js
```

Synthetic quota fixtures require a second explicit setting:

```console
TRACING_UI_TOKEN_RATE_LIMIT=true \
TRACING_UI_FIXTURE_MODE=token-rate-limit \
node server.js
```

The fixture view uses the normalized `/api/v1/token-rate-limit` contract and
shows principal `alice`, the canonical model, both ingress consumers, one
shared quota key, admission, remaining capacity, reset and `Retry-After`
details, provider distribution, overlay revision, and the complete admitted or
denied path. Denied HTTP 429 requests visibly stop after quota admission and
have no provider or backend hop. Available fixture states are `admitted`,
`exhausted`, `concurrent-race`, and `recovered`.

The contract is intentionally independent of OTel exporter attribute names:
`request`, `quota`, `route`, `http`, and `trace` are normalized at the adapter
boundary. Synthetic fixtures and the live server-side adapter populate the
same UI contract and remain visibly distinguished by their provenance label.

### Live distributed-quota profile

The live profile sends authenticated requests from the UI server, never from
browser JavaScript. Configure both consumer gateways and provide the demo
password through an environment variable or mounted file:

```console
TRACING_UI_TOKEN_RATE_LIMIT=true \
TRACING_UI_TOKEN_CONSUMER_A_URL=http://consumer-a.example:8080 \
TRACING_UI_TOKEN_CONSUMER_B_URL=http://consumer-b.example:8080 \
TRACING_UI_TOKEN_USERNAME=alice \
TRACING_UI_TOKEN_PASSWORD_FILE=/run/secrets/alice-password \
TRACING_UI_TOKEN_MODEL=Qwen/Qwen3-0.6B \
TRACING_UI_TOKEN_LIMIT=60 \
TRACING_UI_TOKEN_WINDOW_SECONDS=60 \
PORT=3001 \
node server.js
```

`TRACING_UI_TOKEN_PASSWORD` is available for isolated local development, but a
mounted secret file is preferred. Neither form is returned through the API or
included in browser assets.

When the complete live contract is present, the page switches to the focused
distributed-token-quota profile. It hides unrelated GLB and llm-d generators
and shows:

- Consumer Gateway A and Consumer Gateway B as separate edge entries;
- one shared Valkey quota ledger;
- west, central, and east provider gateways from the Grid overlay;
- explicit request buttons for both consumers;
- one persistent observed row and compact request path per response;
- live provider attribution and rate-limit response headers;
- pre-provider `429` and `503` paths with no provider placeholder;
- a clear-results action that changes only bounded UI history.

The in-memory display history is capped at 100 requests. Clearing it does not
reset Valkey, delete traces, restart gateways, or change provider/backend
counters. Admitted responses that do not contain rate-limit headers show their
observed token usage without fabricating a remaining-quota value. Authoritative
limit, remaining, reset, and `Retry-After` values appear when emitted by the
gateway.

When `llm-d/EPP` is selected, Generate Requests sends real HTTP traffic through
the selected consumer gateway. `Traffic origin` chooses Pool A or Pool B as the
gateway where the request enters; it does not tell Grid which provider to
select. `Concurrent workers` controls simultaneous requests, and `Tokens/request`
controls response duration. Use the documented pressure values (24 workers
and 64 tokens) to make EPP queue pressure visible; the UI records gateway
status, latency, and `X-Grid-LlmD-Provider-Gateway` attribution. These gateway
observations remain clearly labeled sampled when the gateway image does not
emit an OTel trace.

For a sustained pressure test, use **Run sustained load** below the ordinary
request generator. Select the gateway where pressure should enter, duration,
total request rate, worker concurrency, and a pressure pattern. **Pulse
batches** preserves burst-and-recovery behavior; **Sustained workers** keeps
independent workers replenishing requests until the duration expires or you
stop the job. The provider cards and EPP details continue to refresh while the
load runs. The load panel reports ingress-gateway verification, HTTP outcomes,
and provider attribution; it does not claim that the selected ingress pool was
the provider chosen by Grid. This control is available only for the live
llm-d/EPP source and requires both Kind pool contexts.

## Scoring model

Matches the Grid scoring crate:

- Locality weight: 3.0 (Local=1.0, Remote=0.4)
- Queue depth weight: 5.0 (inverted: lower queue = higher score)
- Composite = locality_weight * locality + queue_weight * (1 - queue_depth)

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | UI server port |
| `JAEGER_URL` | `http://localhost:16686` | Jaeger query API base URL |
| `JAEGER_UI_URL` | value of `JAEGER_URL` | Browser-visible Jaeger UI base URL used by **Open raw trace**; set this to the forwarded/public Jaeger address when the dashboard is remote |

Raw-trace links are shown only for requests with an indexed Jaeger trace. Live
gateway responses from the llm-d/VCR request generator are real HTTP results,
but they are sampled gateway observations when no OTel trace ID is returned;
their request details therefore show **Raw trace unavailable for this
observation** instead of navigating to a dummy `/#` URL. The same rule applies
to local demo rows and any other observation without exact trace evidence.

## Teardown

```console
./scripts/stop.sh
```

## Optional development checks

These checks are for UI development and are not required to start or present
the live llm-d/EPP demo. The presentation workflow should start the UI, keep
the Kind clusters running, and observe the real metrics and routes instead.

```console
npm test
```
