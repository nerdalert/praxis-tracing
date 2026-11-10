# Grid / Dynamo Frontend Signal Demo Proof Contract

This demo shows Grid using actual Dynamo Frontend telemetry to prefer a less
pressured inference pool. It exercises real Dynamo Frontend and Mocker
processes, the Grid operator, the published overlay, Gateway consumption, and
fresh route probes with truthful header and counter evidence. The Site
GridSiteRoute path emits response attribution; the Hub pressure path does not.
It does not measure weighted-share precision.

The Hub operator's GridNetwork contains the two co-located Dynamo pools and
the pressure Gateway. The Site operator's GridNetwork securely polls the Hub,
contains its local Dynamo pool, and serves the separate cross-site Gateway.
This keeps each operator within Grid's one-GridNetwork-per-operator contract.
The cross-site route exercises Grid SiteSignals and a live RouteSnapshot. Its
remote Dynamo Frontend remains visible as a real telemetry source, but its
adapter observation is not relayed as a comparable pressure sample, so the
pressure score never compares it with local pools.

## Source and runtime identity

Every live panel carries a state label (`LIVE`, `STALE`, `UNAVAILABLE`,
`CONFIGURED`, or `HISTORICAL`) and an observation time. It also shows the Grid
source-state hash, Grid commit, operator/Gateway image digests, Dynamo image
digest, architecture, Kind context, namespace, pool and model. Browser APIs
return only this allowlisted identity and public runtime state. They never
return kubeconfigs, certificates, auth headers, tokens or secret values.

## Live facts and evidence

| Claim shown in the UI | Required live evidence |
| --- | --- |
| Three pool traffic counters follow generated requests | A bounded batch of new requests travels through the real Site Gateway. Each pool card shows the live `praxis_http_requests_total` delta since the presenter last reset the display baseline, plus the current batch's count from emitted `x-grid-site` and `x-grid-backend` response headers. Resetting the display does not alter Gateway Prometheus counters. Baseline qualification requires all three counters to increase. The presenter can pressure any pool from its own card; while the Site Gateway observes a target at the configured Grid comparison reference, new requests must avoid it, and after recovery a new sample must show traffic returning. The concurrent local-pool gate pressures A and B together and checks both stay at zero while the unpressured remote pool receives the 24-request sample. This is a routing observation, not weighted-share precision. |
| Two independent Dynamo pools are available | Distinct run-owned pool identities, each backed by its own Frontend and Mocker containers on the pinned Dynamo planner image; both Frontends report `model_ready=1`; a valid `/v1/chat/completions` request succeeds against each pool. |
| Frontend readiness and work are real | The pool's actual `/metrics` exposition, fetched from its Frontend endpoint; the selected model's `dynamo_frontend_model_ready` and Frontend-wide `dynamo_frontend_active_requests` series; scrape time and freshness. The UI never treats an absent gauge as zero. |
| Bounded load creates observed work | The UI starts at most four concurrent direct Mocker requests with a bounded duration and cancellation; the response shows completed/in-flight counts and the sampled Frontend active count as a plain `active_requests=N` gauge. The comparable Grid profile and its configured pressure reference are shown separately; that reference is not a Dynamo queue limit, worker count, or measured serving capacity. Pressure is displayed only while the live Frontend scrape is fresh. |
| Grid changes its candidate decision | Fresh operator/Gateway signal and score metrics show pool score and rank before and during load. The UI labels the score as Grid's comparable request-pressure score and displays the active adapter/profile. Dynamo Frontend stage counts, when present, are shown only as Frontend stage counters. They are never called EPP queues. |
| Published configuration reaches the Gateway | The rendered/distributed overlay revision and the Gateway's consumed/mounted revision are read independently from their live sources and shown side by side with observation timestamps. A publish alone is not treated as consumption. |
| A new request follows the changed route | A fresh unique request ID is sent through the live Hub Gateway. That Gateway uses Praxis `intelligent_route`, which does not emit `x-grid-site`, `x-grid-backend`, or `x-grid-provider-site` response headers. The UI says those headers were not emitted and identifies the selected backend only when exactly one live `praxis_http_requests_total` cluster counter increases across the isolated probe. This is Gateway metric evidence, not a response header. The separate Site `grid_site_route` probe displays its actual `x-grid-site` and `x-grid-backend` headers; `x-grid-provider-site` appears only when the remote provider Gateway emitted it. |
| Release returns the system to baseline | The load controller confirms all owned direct requests have ended. Fresh Frontend metrics show `active_requests=0`; a fresh score/rank and overlay revision are read; the Gateway consumed revision matches; then a new successful route probe demonstrates recovery. |
| Optional signal endpoint interruption | If the optional control is included, it changes only the run-owned peer `GridSite.spec.signalsEndpoint.address` to a documented, unserved port, while checking that the provider Gateway address and endpoint remain unchanged/reachable. The Site Gateway retains its latest Hub sample until its configured `load_window_ms` expires; after the live peer-unavailable condition has persisted beyond that window, the Hub candidate scores must be `UNAVAILABLE` and the Site pool sample must remain fresh before the UI enables the local-fallback probe. It then proves local fallback with a real request, restores the exact saved address, and demonstrates fresh remote recovery. It is not described as a network ACL or live SWIM partition. |
| Scope limits are visible | The UI and slides say that Mocker returns synthetic inference responses while Dynamo Frontend runtime metrics are real. This proves no GPU saturation, model quality, weighted-share precision, or live SWIM behavior. Jaeger is absent/unavailable unless a real, exact-correlated trace source is configured. |

## Correlation rule

For each route probe or generated Site Gateway request, retain a single record
containing request ID, request and response timestamps, response status and
schema validation, the response headers that route actually emitted, the
Frontend readiness and active-request samples nearest to the request,
selected provider/pool evidence, and the operator/Gateway metric sample. Hub
local probes also retain the independently read published and consumed overlay
revisions. Site requests retain the GridSiteRoute candidate metrics and peer
signal condition instead of borrowing the Hub overlay revision. Mark sources
and ages for every value. An HTTP 200 without this correlation is not a routing
proof.

Load records identify their owned task, start/stop time, worker count, direct
pool endpoint, per-request outcomes, and paired Frontend samples. Every
pressure interval used to claim a route change must overlap fresh positive
`active_requests` observations.

## Acceptance gates

1. **Runtime**: two independent pinned Frontend+Mocker pools start and each
   serves a structurally valid chat completion.
2. **Live baseline**: both pool signals, declared comparable profile/capacity,
   candidate scores/ranks, overlay revision and consumed Gateway revision are
   fresh and visible in the actual UI.
3. **Request counters**: a bounded real Site Gateway batch receives valid
   Mocker responses across all three pools. The Playwright gate pressures Pool
   A and Pool B simultaneously, waits until both Frontend gauges and both Site
   Gateway scores show the configured pressure, then proves both local sample
   counts and counters stay unchanged while the unpressured remote pool gets
   all 24 new requests. After releasing both, it proves local pool traffic
   returns. A separate remote-pool pressure cycle proves the remote card can
   start and recover its own pressure. The UI reset control changes only the
   displayed counter baseline; Prometheus counters remain cumulative.
4. **Pressure**: a bounded UI action creates real direct Mocker requests and
   proves positive Frontend active work from `/metrics` while it is outstanding.
5. **Routing**: the score/rank changes, a new overlay revision is published
   and consumed, and a new Gateway probe succeeds. For the Hub's
   `intelligent_route`, one unique request-counter increment identifies the
   selected backend; the UI leaves response attribution headers absent. The
   Site `grid_site_route` path proves emitted site/backend attribution.
6. **Recovery**: stopping load produces fresh zero-active Frontend signals,
   Grid/Gateway revision convergence, and a fresh successful route probe.
7. **Optional interruption**: if the UI includes this control, a test proves
   the peer signal endpoint goes unavailable, waits for the Site Gateway's
   configured load freshness window to expire, observes unavailable Hub scores
   and a fresh Site pool sample, proves local fallback while the provider
   Gateway remains reachable, restores the peer signals, verifies a fresh Site
   Gateway candidate set, and sends a new request whose actual attribution and
   unique backend counter agree. The destination follows current route state.
8. **UI quality and safety**: Playwright runs at 1440×900 and a smaller
   viewport; it captures screenshots, detects console/network failures, and
   fails if an unavailable or stale source is rendered as healthy zero/live.
9. **Media preparation**: exactly five editable introduction slides render;
   reviewed AI narration is transcribed from its generated voice tracks. The
   local preview's UI narration and captions follow the supplied historical
   recording's scene timecodes. This preview does not qualify a current live
   deployment. If the user edits its narration, regenerate captions from the
   final audio.

Weighted-routing precision, GPU saturation, model quality and live SWIM are
explicitly outside this proof contract.
