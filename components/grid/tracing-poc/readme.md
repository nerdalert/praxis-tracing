# Grid Tracing POC: OpenTelemetry + Jaeger

Standalone proof-of-concept that traces one inference request through the
Grid routing path and visualises it in Jaeger.

## Architecture

```
                    +-----------------+
                    |   POC Runner    |
                    | (scenarios.rs)  |
                    +--------+--------+
                             |
                    POST /v1/chat/completions
                             |
                             v
               +-------------+--------------+
               |     Consumer Gateway       |   :3100
               |  - extract traceparent     |
               |  - score_backends()        |
               |  - select provider         |
               |  - inject traceparent      |
               +--+---------------------+--+
                  |                      |
          pool-a preferred         pool-b preferred
          (low queue_depth)        (high queue_depth)
                  |                      |
                  v                      v
      +-----------+--------+  +---------+-----------+
      | Provider Gateway A |  | Provider Gateway B  |
      |      (pool-a)      |  |      (pool-b)       |
      |       :3200        |  |       :3201         |
      +--------+-----------+  +-----------+---------+
               |                          |
               v                          v
      +--------+-----------+  +-----------+---------+
      |  Mock Backend A    |  |  Mock Backend B     |
      |     (pool-a)       |  |     (pool-b)        |
      |       :3300        |  |       :3301         |
      +--------------------+  +---------------------+

All services export spans via OTLP HTTP:

      POC binary --> OTLP HTTP --> OTel Collector --> OTLP gRPC --> Jaeger
                      :4318          :4317                         :16686
```

This is a **synthetic POC**. It does not instrument real Praxis gateways.
The consumer/provider gateways above are mock axum servers running inside
the POC binary. They use the real `scoring` crate for routing decisions
and real W3C `traceparent` propagation across HTTP boundaries.

## Prerequisites

- Rust 1.96+ (`rustup install 1.96.0`)
- Docker and Docker Compose
- Ports 3100-3301, 4317-4318, 16686 available

## Quick start

Start infrastructure and run the quick test (one request):

```console
# From the grid/ directory:
./tracing-poc/scripts/run-poc.sh
```

Run the full routing-transition test:

```console
./tracing-poc/scripts/run-poc.sh --mode full
```

## Manual commands

```console
# Start Jaeger + OTel Collector
docker compose -f tracing-poc/docker/docker-compose.yaml up -d

# Build and run
cargo run -p tracing-poc -- --mode quick
cargo run -p tracing-poc -- --mode full

# Teardown
./tracing-poc/scripts/teardown.sh
```

## Required quality checks

```console
cargo fmt --all -- --check
cargo check --workspace --locked
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
```

## Jaeger UI

Open <http://localhost:16686/search> after running a scenario.

To find a trace by ID: <http://localhost:16686/trace/{TRACE_ID}>

## Expected spans and attributes

Each request traverses 3 network hops (client -> consumer, consumer ->
provider, provider -> backend) and produces 4 spans. The
`consumer.route_select` span is a local routing decision, not a network hop:

| Span | Service | Key attributes |
|------|---------|----------------|
| `consumer.inbound` | consumer-gateway | `grid.network`, `consumer.site`, `http.method`, `http.route` |
| `consumer.route_select` | consumer-gateway | `selected.provider`, `selected.cluster`, `selected.site`, `provider.kind`, `routing.policy`, `provider.score`, `provider.rank`, `routing.decision` |
| `provider.inbound` | provider-gateway | `grid.pool`, `selected.site`, `provider.kind` |
| `backend.inference` | mock-backend | `grid.pool`, `provider.kind` |

### Routing metadata

The `consumer.route_select` span captures the full routing decision:

- `selected.provider` — which backend was chosen (e.g. `llmd-pool-a-provider`)
- `selected.cluster` — cluster/site name (e.g. `pool-a`), not the provider ID
- `provider.score` — computed score from the scoring engine
- `provider.rank` — zero-based rank in the scored list
- `routing.policy` — active policy (e.g. `scoreFirst`)
- `routing.decision` — human-readable summary

### How routing transitions appear

In full mode, three traces show the A-to-B-to-A transition:

1. **Baseline**: `selected.provider=llmd-pool-a-provider` (local advantage, score=5.5)
2. **Pressure failover**: `selected.provider=llmd-pool-b-provider` (pool-a queue saturated at 0.95, score=3.7)
3. **Recovery**: `selected.provider=llmd-pool-a-provider` (queue recovered to 0.1, score=7.5)

## Security and privacy

The POC never includes in span attributes:

- Prompt contents or response bodies
- Authorization headers or API keys
- Cookies or session identifiers
- Credential values (only credential references)

This is enforced by the span definitions in `gateway.rs`, `backend.rs`,
and tested in unit tests.

## Comparison with real Grid architecture

This POC simulates the real Grid request path. The production architecture differs:

| Aspect | POC | Production |
|--------|-----|------------|
| Consumer gateway | Mock axum server in POC binary | Praxis AI (`../ai/` repo) |
| Routing decision | `scoring::score_backends()` called directly | Praxis `intelligent_route` filter consuming overlay |
| Overlay source | In-memory `ScoringSnapshot` | ConfigMap via overlay-sync sidecar |
| Provider gateway | Mock axum server in POC binary | Praxis AI with `provider_route` + `peer_identity_trust` |
| Credential handling | Not simulated | Praxis `credential_inject` filter |
| Transport security | Plain HTTP | mTLS between edge and provider gateways |
| Trace context | W3C traceparent via OTel propagator | Not yet implemented in Praxis |

### Where real instrumentation should go

1. **Consumer edge**: Add traceparent extraction + SERVER span as the first filter or at the HTTP server layer in Praxis
2. **After `intelligent_route`**: Emit a `grid.provider.select` event with `overlay.revision`, `stable_id`, `admission_state`, `rank`
3. **Edge → provider**: Add CLIENT span, inject traceparent into outbound mTLS request
4. **Provider ingress**: Extract traceparent, create SERVER span after `peer_identity_trust`
5. **Provider egress**: Add CLIENT span for the backend request — this is the initial terminal proof point

### Headers already available at the request boundary

The production Praxis filters already emit these safe attribution headers:

- `x-ai-routing-candidate` — stable candidate ID from overlay
- `x-ai-routing-request-id` — request correlation ID
- `x-ai-provider-routing-revision` — content-addressed overlay revision
- `x-grid-demo-*` — demo attribution echoed by mock backends

These can be read by tracing middleware without modifying filter behaviour.

### Overlay revision propagation

```
Grid Operator → ConfigMap (grid-overlay-{network}-{gateway})
    → overlay-sync sidecar (Kubernetes watcher + atomic file write)
    → Praxis hot-reload (file watch, debounce 500ms)
    → ArcSwap snapshot in Praxis memory
```

The content-addressed revision (SHA-256) is the correlation key between
control-plane state and request-plane traces.

## Known gaps

| Gap | Reason |
|-----|--------|
| `overlay.revision` | Available in `RoutingOverlay` but not passed to mock data-plane |
| `service.version` / image tag | Not available in mock services |
| `traffic.weight` | Not yet in the scoring engine |
| Real Praxis gateway spans | Praxis is a separate repository |
| mTLS between gateways | POC uses plain HTTP |
| Kubernetes-based demo | POC runs standalone |
| Peer identity verification | Not simulated (requires mTLS) |
| Credential boundary events | Not simulated |
| Session affinity tracing | Not implemented |

## Troubleshooting

### Missing spans

1. Check the OTel Collector is running: `docker compose -f tracing-poc/docker/docker-compose.yaml ps`
2. Check Collector logs: `docker compose -f tracing-poc/docker/docker-compose.yaml logs otel-collector`
3. Verify OTLP endpoint is reachable: `curl http://localhost:4318/`

### Broken propagation

1. Verify `traceparent` header is present in the response: look for `x-grid-traceparent`
2. Check the consumer gateway log for `routing decision` with the expected provider
3. Ensure no middleware strips `traceparent` headers

### Jaeger returns 404 for a trace

1. The POC uses bounded polling (up to 15 seconds) to wait for trace ingestion
2. Re-run with `RUST_LOG=debug` for verbose output
3. Check Jaeger is healthy: `curl http://localhost:16686/api/services`

## Tests

```console
cargo test -p tracing-poc              # unit tests (no Docker needed)
cargo clippy -p tracing-poc -- -D warnings  # lint check
```

14 unit tests covering:
- Trace-context propagation round-trip
- Span creation on successful requests
- Absence of prompt/credential/body attributes
- Routing attributes from scoring
- Scoring transitions (baseline -> pressure -> recovery)
- Jaeger API response parsing
