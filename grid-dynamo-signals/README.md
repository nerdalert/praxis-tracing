# Grid × Dynamo signal routing demo

This module adapts the familiar Praxis Tracing static/weighted demo dashboard to Grid's versioned Dynamo Frontend signal adapter. It keeps the existing Grid implementation backend and shows real `model_ready` and `active_requests` Frontend gauges, Grid candidate score/rank, overlay revisions, Gateway consumption, and observed request attribution.

## What is reused

The page is a Dynamo-specific React dashboard adapted from the `grid-dynamic-weighting` presentation. It retains the familiar header, status strip, pool cards, score tables, request ledger, and topology presentation. Its `weighted-reference.css` stylesheet records the visual starting point; the dashboard component and data adapters are purpose-built for Dynamo and the demo backend in `app/server.mjs`. The old EPP queue-depth and weighted-share controls were not carried over.

The three serving pools are two independent Dynamo Frontend + Mocker Pods in the local Kind site and one Frontend + Mocker Pod in the remote Kind site. The Hub local overlay compares Pool A and Pool B. The Site Gateway consumes a separate cross-site snapshot that includes the remote pool. Dynamo Frontend selects its own Mocker worker; Grid selects a pool or site from the signals it receives.

## Proof and limits

See [DEMO-PROOF-CONTRACT.md](docs/DEMO-PROOF-CONTRACT.md) for the live evidence required at each boundary and [PRESENTER-RUNBOOK.md](docs/PRESENTER-RUNBOOK.md) for the controls. Pressure starts only after a presenter clicks **Generate pressure** on a pool card. The bounded requests go directly to that pool's Mocker. Requests created by **Generate requests** travel through the Site Gateway as chat completions and follow its current snapshot.

Mocker responses are synthetic and the Frontend telemetry is real. The demonstration does not prove GPU saturation, model quality, weighted-share precision, or live SWIM behavior. The supplied silent recording does not show the optional signal-endpoint interruption control.

The saved qualification is historical and is tied to Grid source-state hash `c7bc7a45c371ea7503dda53ef39cee65700d359921f3f9dbafaed9840ff91df2`, Grid commit `0fc905dfae058e5c54ddebdc384e345fbfecc1a4`, and Dynamo planner image digest `sha256:f69ac8f2165289e0f9d06aa125fac8bda3a401b42f640235fca28b0c852b9875` (`linux/amd64`). The detailed review and screenshots in the publishing workspace are historical evidence, not a current live deployment. The packaged backend changed after that Playwright run, so no current-source live E2E pass is claimed. Weighted-share precision was not tested.

## Run the dashboard

This source module contains the page and API server. A run-owned environment must first provide its private configuration and live cluster endpoints. The configuration is intentionally absent from Git. The prior Kind clusters were removed. This module currently does not include the provisioning script referenced by `start-ui.sh`, so a fresh live startup is not ready from this checkout alone.

```sh
npm ci
npm run build:ui
```

The intended live app URL is `http://127.0.0.1:4177` after a run-owned environment has been provisioned and `./scripts/check-live-readiness.sh` passes. Do not use a leftover listener, recorded screenshot, or saved run state as live values.

Build the frontend without contacting a cluster:

```sh
npm run build:ui
```

The live Playwright suite can create real Mocker pressure and requests. Run it only with an explicitly configured, run-owned demo environment and an operator-presenter who intends to exercise those controls. The saved passing run is historical; the later 300-second pressure run was interrupted and is not a pass.

## Slides and media

The five-slide introduction has editable PowerPoint shapes at `media/source-deck/grid-dynamo-intro.pptx` and editable HTML at `media/slides/deck.html`. Rebuild the PowerPoint deck with Python and `media/source-deck/requirements.txt`. Render the HTML slides at 1920×1080 with `npm run render:slides -- media/slides/rendered`.

Narration source is under `media/narration/`; reviewed AI-generated voice tracks are under `media/audio/`, and word-timed captions are under `media/captions/`. The HTML slides disclose AI-generated narration. The local preview combines these assets with the supplied historical UI recording and includes an English soft-caption track. Its MP4 and the raw recording stay outside Git. Use [RECORDING-HANDOFF.md](docs/RECORDING-HANDOFF.md) for preview assembly and [AUDIO-MODEL-STATUS.md](docs/AUDIO-MODEL-STATUS.md) for the exact models and their support status. Reusable production tooling is in [Traffic Theater](https://github.com/nerdalert/traffic-theater/tree/main/examples/grid-dynamo-signals).

After generating or reviewing narration and captions, assemble a local preview with:

```sh
npm run build:preview -- \
  --ui /path/to/grid-dynamo-v1.mp4 \
  --output /path/to/local-preview
```

The builder places each caption section on its source timecode, preserves
recording and speech speed, and fails if a voice segment exceeds its window.
