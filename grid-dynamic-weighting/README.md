# Grid weighted routing dashboard

This is the operational dashboard for the experimental Grid weighted-routing
qualification. It reads live Kubernetes, EPP, Grid overlay, Praxis revision,
and HTTP provider-selection state. It does not fabricate pressure or traces.

## What it shows

- three neutral pools across three independent Kind clusters;
- configured capacity, simulator-reported queue depth, and queue utilization;
- Grid's expected new-request share, excluding `existing_only` candidates;
- measured provider selection from the current sampler run and bounded rolling
  request history;
- Grid, Praxis accepted, and Praxis serving revisions per gateway;
- simulator update, restart, EPP observation, overlay, and serving progress.

Static capacity is operator intent. Dynamic weighting adjusts that capacity from
the selected EPP pressure signal. Sampling traffic measures the result and does
not create simulator queue pressure.

## Run against the retained Kind qualification

```console
TRACING_UI_PROFILE=llmd \
VCR_LIVE=true \
VCR_KUBECTL_CONTEXT_A=kind-grid-llmd-pm-pool-a \
VCR_KUBECTL_CONTEXT_B=kind-grid-llmd-pm-pool-b \
VCR_KUBECTL_CONTEXT_C=kind-grid-llmd-pm-pool-c \
HOST=127.0.0.1 \
PORT=3001 node server.js
```

Open <http://localhost:3001>. The dashboard refreshes live state every second.
Jaeger is optional; when it is unavailable, the dashboard keeps Grid state and
provider attribution live and labels distributed tracing unavailable.

## Validate

```console
npm install
npm test
npm run build
npx playwright test test/weighted-routing.spec.js
git diff --check
```

Use the six introductory slides and closing frame in `slides/`, together with
the timed narration in `media/weighted-routing-intro.srt`, when assembling a
recording. The source recording must be available locally before creating a
combined video; inspect it with `ffprobe` rather than guessing its timing.

## Operational boundaries

The dashboard's metric controls patch the simulator ConfigMap, restart the
simulator Deployments, wait for replacement pods, wait for EPP to expose the
metric, and wait for Grid/Praxis convergence. The current run's measured share
is calculated from successful requests with a selected provider; a rolling
window is shown separately. Existing-session affinity and `existing_only`
drain behavior are not new-request weighting.

The local control API can patch simulator state and restart simulator pods. It
has no authentication unless `TRACING_UI_AUTH_USERNAME` and
`TRACING_UI_AUTH_PASSWORD` are both set, so the server binds to `127.0.0.1` by
default. Configure authentication before setting `HOST=0.0.0.0` outside an
isolated demo environment.
