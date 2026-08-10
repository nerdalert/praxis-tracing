# Praxis Tracing

OpenTelemetry, Jaeger, and Grid routing observability experiments for Praxis
AI gateways.

This repository contains the validated tracing proof of concept, the browser
observability UI, runnable demo orchestration, and clean source snapshots of
the Grid and Praxis AI components used to build the experimental images.

## Quick start: synthetic tracing

Prerequisites: Rust, Docker Compose or Podman Compose, Node.js, and an available
Jaeger port. The scripts prefer Docker Compose and use Podman Compose only when
Docker Compose is unavailable. Set `COMPOSE_RUNTIME` to choose explicitly.

```console
./scripts/run-tracing.sh --poc quick
```

Open:

- Observability UI: <http://localhost:3001>
- Jaeger: <http://localhost:16686>

Run the complete synthetic A→B→A scenario:

```console
./scripts/run-tracing.sh --poc full
```

Stop the local services:

```console
./scripts/run-tracing.sh --teardown
```

## UI development checks

The live demo does not require running automated test suites. To run the
optional UI development checks:

```console
cd routing-observability-ui
npm install
npm test
npx playwright test
```

The UI supports a common provider, routing, pressure, score, timeline, and
trace view across GLB and llm-d/VCR sources. It can run in live mode when
Jaeger and Kubernetes are available. Missing live sources are shown as
`UNAVAILABLE`; deterministic demo mode requires the explicit
`ALLOW_SIMULATION=true` opt-in and is never presented as runtime evidence.

## What is included

- `routing-observability-ui/` — browser dashboard and server-side adapters for
  Jaeger, GLB, and live llm-d/EPP/VCR data.
- `grid/` — the minimal Grid source snapshot needed by the tracing POC,
  including `tracing-layer`, `tracing-poc`, and the scoring engine.
- `components/grid/` — the full Grid source snapshot used for demo validation.
- `components/ai/` — the Praxis AI source snapshot used for the OTel-enabled
  gateway image.
- `components/demos/` — the GLB, combined-site, and llm-d pool-metrics demo
  assets. MAAS demos are intentionally not included.
- `scripts/` — Jaeger/OTel, synthetic POC, real Praxis, and validation
  orchestration.

For live llm-d/EPP/VCR metrics, use the pool-metrics Kind contexts:

```console
cd routing-observability-ui
JAEGER_URL=http://localhost:16686 \
VCR_LIVE=true \
VCR_KUBECTL_CONTEXT_A=kind-grid-llmd-pm-pool-a \
VCR_KUBECTL_CONTEXT_B=kind-grid-llmd-pm-pool-b \
PORT=3001 node server.js
```

## Demo assets

- **[Grid llm-d pool metrics](components/demos/grid-llmd-pool-metrics/readme.md)** — VCR-backed two-cluster llm-d/EPP scoring, pressure, failover, recovery, and optional metrics-mTLS.
- **[Grid GLB demo](components/demos/grid-glb-demo/readme.md)** — multi-hop global load balancing through GTM, edge, and provider gateways.
- **[Grid combined-site](components/demos/grid-combined-site/readme.md)** — colocated multi-site routing with the same VCR-backed provider pattern.
- **[QueueDepth routing demo video](https://drive.google.com/file/d/1VZlxfl1fSFTYE0VnFmCb1Zxt9ufA7ox1/view?usp=sharing)**

These are the canonical demo assets.

The VCR backend is documented at
<https://github.com/neuralmagic/vllm-vcr/blob/main/README.md>.

The OTel-enabled Praxis AI fork used by the tracing demos is
<https://github.com/nerdalert/ai/tree/grid-otel-demo>. The fork contains the
experimental tracing hooks and must be used when running the real Praxis/GLB
path; the standard released Praxis image does not provide those hooks.

<img width="975" height="1115" alt="grid-queuedepth-demo" src="https://github.com/user-attachments/assets/85c6bc51-efb2-45df-857f-0d93d28c0802" />

## Status

This is an experimental observability repository. The tracing UI and synthetic
POC are functional and tested. The production Praxis instrumentation and
Grid demo integrations are intentionally isolated from the upstream Praxis and
Grid repositories until the design is complete.

The OTel-enabled Praxis AI feature branch used by the real tracing demos is
[nerdalert/ai `grid-otel-demo`](https://github.com/nerdalert/ai/tree/grid-otel-demo).

See `runbook.md` for the reproducible runtime workflow and known limitations.

The current v2 implementation checkpoint and its validation notes are in
[`docs/v2-implementation.md`](docs/v2-implementation.md).
