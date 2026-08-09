# Praxis Tracing

OpenTelemetry, Jaeger, and Grid routing observability experiments for Praxis
AI gateways.

This repository contains the validated tracing proof of concept, the browser
observability UI, runnable demo orchestration, and clean source snapshots of
the Grid and Praxis AI components used to build the experimental images.

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
- `public-demos/` — compact demo wrappers and validation documentation.

## Quick start: synthetic tracing

Prerequisites: Rust, Docker Compose or Podman Compose, Node.js, and an available
Jaeger port. The scripts prefer Docker Compose and use Podman Compose only when
Docker Compose is unavailable. Set `COMPOSE_COMMAND` to choose explicitly.

```console
./scripts/run-tracing.sh --poc quick
```

Open:

- Observability UI: <http://localhost:8080>
- Jaeger: <http://localhost:16686>

Run the complete synthetic A→B→A scenario:

```console
./scripts/run-tracing.sh --poc full
```

Stop the local services:

```console
./scripts/run-tracing.sh --teardown
```

## UI validation

```console
cd routing-observability-ui
npm install
npm test
npx playwright test
```

The UI supports a common provider, routing, pressure, score, timeline, and
trace view across GLB and llm-d/VCR sources. It can run in live mode when
Jaeger and Kubernetes are available, or in deterministic demo mode when they
are not.

For live llm-d/EPP/VCR metrics, use the pool-metrics Kind contexts:

```console
cd routing-observability-ui
JAEGER_URL=http://localhost:16686 \
VCR_LIVE=true \
VCR_KUBECTL_CONTEXT_A=kind-grid-llmd-pm-pool-a \
VCR_KUBECTL_CONTEXT_B=kind-grid-llmd-pm-pool-b \
PORT=8080 node server.js
```

## Demo assets

The validated VCR-backed pool-metrics demo is in
`components/demos/demos/grid-llmd-pool-metrics/`. The GLB and combined-site
assets are beside it. The authoritative runtime instructions remain in each
demo README.

The VCR backend is documented at
<https://github.com/neuralmagic/vllm-vcr/blob/main/README.md>.

The OTel-enabled Praxis AI fork used by the tracing demos is
<https://github.com/nerdalert/ai/tree/grid-otel-demo>. The fork contains the
experimental tracing hooks and must be used when running the real Praxis/GLB
path; the standard released Praxis image does not provide those hooks.

## Status

This is an experimental observability repository. The tracing UI and synthetic
POC are functional and tested. The production Praxis instrumentation and
Grid demo integrations are intentionally isolated from the upstream Praxis and
Grid repositories until the design is complete.

See `runbook.md` for the reproducible runtime workflow and known limitations.
