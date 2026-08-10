# v2 implementation notes

## purpose

This document records the first implementation slice from the public v2
research design. It is intentionally separate from the runtime runbook so
that product decisions and validation evidence remain easy to review.

## implemented in this checkpoint

- Added a versioned `/api/v1` contract without removing the existing UI APIs.
- Added capability detection for environment profile, live/demo mode, Jaeger,
  EPP, Grid overlay, route attribution, request generation, and replay.
- Added normalized request summaries with request ID, trace ID, provider,
  routing decision, timing, status, trace quality, and field provenance.
- Added cursor-shaped pagination with bounded page size and time/provider
  filters. The current in-memory adapter is a demo-scale implementation; a
  production adapter must preserve the cursor contract while moving summary
  search to durable storage when volume requires it.
- Added an SSE request-event stream for request creation, generation progress,
  generation completion, and replay progress.
- Made Generate Requests global in the UI. Demo mode generates local synthetic
  requests and labels them `SIMULATED`; live GLB retains its gateway target;
  unsupported live sources remain visible with an explanation.
- Added an explainable 0–100 experience score based on HTTP result, total
  latency, TTFT when available, and retry/failover penalty. Missing timing is
  explicitly described rather than treated as zero or failure.
- Added request detail with observed path, score explanation, provenance,
  trace quality, span summary, raw Jaeger link, and replay safety state.
- Added synthetic-only replay jobs. The implementation never reuses an
  original prompt or response body.
- Added a bounded history scrubber for the currently loaded request window.
  It is a UI-scale replay view, not yet a durable event-store time machine.
- Added Playwright coverage for desktop, mobile, request generation, request
  detail, replay labeling, and history scrubbing.

## validation checkpoint

Run from `routing-observability-ui/`:

```console
npm test
npx playwright test test/visual.spec.js --grep "request explorer|demo generation|history scrubber"
```

Checkpoint result on 2026-08-09:

- API tests: 61 passed.
- New request-centric Playwright tests: 4 passed.
- Existing targeted visual checks: 3 passed.
- Fidelity run: generated 8 simulated requests and rendered the request table,
  provider context, score explanation, detail view, and synthetic replay action.
- Kind clusters were torn down before this checkpoint; no Kubernetes runtime
  was required for the demo-mode validation.

## fidelity observations

- The request table is now the strongest primary story: it makes provider,
  status, experience, timing, score/rank, and trace quality comparable per
  request.
- The detail panel is intentionally evidence-led. It distinguishes an
  observed path from an unavailable full span payload and labels simulated
  values.
- The provider and pressure sections remain useful context, but should not
  compete with the request list for initial attention.
- The next visual pass should add presenter-oriented demo controls inside the
  request explorer, not create a second source-specific page.

## known limitations and next slice

- Demo requests currently use deterministic synthetic timing and routing; they
  are not real inference calls.
- Live request normalization currently reads a bounded Jaeger sample. It does
  not yet use Jaeger QueryService v3 or a durable summary index.
- The history scrubber bounds the loaded browser dataset; it does not yet
  reconstruct arbitrary historical windows from an event store.
- Replay authorization is intentionally minimal for the standalone demo. A
  production implementation needs actor identity, audit records, redaction
  preview, destination allowlists, rate limits, and cancellation.
- Full span waterfalls are lazy in concept but the current adapter only
  exposes the span summary already returned by the source.
- EPP selection-time metrics are still correlated at provider/dashboard level;
  the next slice must make `at selection` versus `now`, freshness, and source
  quality explicit in request detail.

## next implementation order

1. Add a presenter/demo controller with canned load scripts and visible
   scenario progress.
2. Add request-event buffering and a real interval/timeline replay model.
3. Add lazy trace detail and explicit selection-time EPP/Grid signal cards.
4. Add GLB/VCR live generator adapters behind the same Generate Requests
   contract.
5. Introduce React/TypeScript only after the normalized contracts stabilize,
   preserving this working adapter during the migration.

## second checkpoint: presenter and evidence refinement

Additional work completed after the first checkpoint:

- Added presenter scripts with explicit phases, expected behavior, progress,
  stop, and automatic completion. Scripts cover baseline → pressure → recovery
  and provider degradation → recovery.
- Added `/api/v1/demo/scripts`, `/api/v1/demo/runs`, `/api/v1/demo/status`, and
  `/api/v1/demo/stop`.
- Added selection-time queue-depth and KV-cache fields to normalized requests,
  including source and quality labels.
- Expanded experience scoring into reliability, latency, routing, technical,
  and trace-confidence components instead of presenting only one opaque score.
- Added `/api/v1/requests/:requestId/trace` for lazy trace retrieval.
- Added presenter controls and progress state to the common request explorer.

Second checkpoint validation:

- API tests: 64 passed.
- Presenter/request Playwright tests: 5 passed.
- Existing visual tests remain covered by the complete suite before handoff.

The presenter controls intentionally refuse to run against an active live
environment unless a real request target is selected. This keeps “demo” from
silently mutating a production-like environment.

## third checkpoint: visual interval replay

- Added `/api/v1/replay/window` with explicit visual-reconstruction semantics.
- Added play, pause, step, and playback-speed controls to the loaded request
  history.
- Added replay-event markers derived from normalized request evidence.
- The replay contract explicitly reports `network_traffic: false`; this is a
  historical UI reconstruction, not executable request replay.

Third checkpoint validation:

- API tests: 65 passed.
- Presenter and replay Playwright tests: 2 passed after the full prior suite.
- Full browser validation is rerun after this slice before handoff.

The live VCR adapter now enriches request detail with the latest EPP queue/KV
sample when a selected provider can be matched. It is deliberately labeled
`sampled` and “not exact selection-time evidence”; a dashboard refresh must
not be mistaken for a historical metric join.

## fourth checkpoint: event burst handling

SSE request-created events are now coalesced for 450ms before the browser
refreshes the request list. This preserves the “live” experience while avoiding
one network/render cycle per request during a burst. The indicator reports the
buffered count while the refresh is pending. A future production stream still
needs server-side gap markers and durable resume positions.

## strict evidence policy

`ALLOW_SIMULATION` defaults to false. The dashboard reports `UNAVAILABLE`
when Jaeger, Grid, Kubernetes, or EPP data cannot be read; users do not need
to understand an internal auto/live mode switch.
Tests and local fixture runs set `ALLOW_SIMULATION=true` explicitly. This is a
test-data switch, not a production fallback, and all such values remain marked
`SIMULATED`.

## strict and demo Playwright matrix

- Strict evidence mode, `ALLOW_SIMULATION=false`: 5 tests passed. Missing
  Jaeger/provider/metrics data produced `UNAVAILABLE` or empty evidence APIs;
  simulation mode and synthetic replay were rejected.
- Explicit simulated mode, `ALLOW_SIMULATION=true`: all four scenarios passed
  through the browser; both presenter scripts started/stopped; GLB, VCR/EPP,
  and Combined shared the same request explorer; replay, inspection, source
  switching, and responsive checks passed.

Final browser checkpoint:

- Full Playwright suite: 33 passed.
- Strict evidence mode: 5 passed with `ALLOW_SIMULATION=false`.
- Explicit simulation mode: 28 passed with `ALLOW_SIMULATION=true`.
- API suite: 65 passed.
- `git diff --check`: passed.
- No Kind clusters were running during this validation, so no Kubernetes
behavior is being claimed by this UI-only matrix.

## research-gap review

| Research item | Current state |
|---|---|
| Unified normalized request contract | Implemented and tested |
| Explicit capabilities and provenance | Implemented and tested |
| Strict missing-source behavior | Implemented and tested |
| Request pagination shape | Implemented in-memory; durable production index remains |
| Request detail and lazy trace endpoint | Implemented; Jaeger adapter remains compatibility API |
| Explainable experience score | Implemented as transparent components; objectives remain configurable |
| Presenter/demo controls | Implemented for explicit simulation; real runtime scripts remain |
| Visual interval replay | Implemented over loaded evidence; durable historical reconstruction remains |
| Synthetic replay safety boundary | Implemented; auth/audit/destination policy remains |
| SSE buffering | Client burst coalescing implemented; server gap/resume remains |
| Exact selection-time EPP/Grid join | Not claimed; live VCR enrichment is explicitly sampled |
| Real GLB/VCR request generation | GLB adapter exists; VCR target adapter and cold runtime validation remain |
| React/TypeScript migration | Deferred until the contract stabilizes |

## checkpoint 6: generation and evidence clarity

- Removed the user-facing `Auto`, `Live`, and `Demo` mode buttons. The header
  now communicates evidence status in plain language: live evidence, live EPP
  metrics, simulation enabled, or unavailable.
- Moved generated-request output directly below the generation controls. Every
  generated request now gets its own result row with sequence, HTTP result,
  path, provider, latency, and trace inspection when a trace is available.
- Synthetic trace IDs no longer link to Jaeger, because they do not exist in
  Jaeger. They open the local synthetic detail view instead. Real trace IDs
  continue to link to Jaeger.
- Provider cards now distinguish `EPP sample` from `not collected here` and
  explain that the Grid routing score is a preference ranking where higher
  scores win. Component contributions are shown when the source provides them.
- Targeted Playwright validation passed for generation result rows, per-request
  paths, request detail, and replay-window behavior. The full preceding matrix
  remained green at 33/33.
- Generator readiness now probes the configured GLB gateway before enabling
  the button. When the Kind context or service is absent, the UI shows the
  exact readiness error, disables generation, and preserves failed-run errors
  across refresh cycles.

## checkpoint 7: focused path view

The primary page was reduced to request-path evidence: request generation and
per-request results, path/topology, request detail, recent traces, and replay.
Provider cards, pressure narrative, score visualization, and the generic event
timeline were removed from the visible surface because their values were not
exactly joinable to the selected request. Their absence is intentional; this
prevents historical or source-mismatched telemetry from looking like path
evidence.
