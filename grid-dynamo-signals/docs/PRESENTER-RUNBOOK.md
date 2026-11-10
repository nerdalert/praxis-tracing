# Presenter runbook

## Adopted dashboard

The recording page uses a Dynamo-specific React dashboard adapted from the
static/weighted demo's visual system and layout. It keeps the familiar header,
pool cards, candidate tables, request ledger, and topology presentation. The
data adapters and controls in `app/server.mjs` are Dynamo-specific; EPP
queue-depth and weighted-share controls are not part of this page.

Editable frontend source is in `frontend/`. `./scripts/start-ui.sh` builds the
React page into `app/public/`, then starts or checks the existing run-owned
server and port-forwards. It requires private kubeconfigs, configuration, and
a provisioned run; those are not included in this checkout. Open
**http://127.0.0.1:4177** only after live readiness passes. At the
top, review the three Frontend pool cards. The Hub local overlay table contains
Pool A and Pool B only. Its note links to the separate Site Gateway snapshot,
which includes all three candidates, including the Remote Pool; use **below ↓**
to jump there if the table is below the fold. Presenter controls follow; the
topology diagram explains the local and peer routes below them. The lower
screen strip stays clear for captions.

## Start and verify

1. Start the live app with `./scripts/start-ui.sh` and open **http://127.0.0.1:4177**. The command rebuilds the adopted frontend before checking the server.
2. Read the pool locations on the dashboard: **Dynamo · Pool A** (`pool-a`) and **Dynamo · Pool B** (`pool-b`) are separate Pods, each with a Dynamo Frontend and Mocker, in Hub cluster `kind-grid-sig-demo-hub` and GridSite `grid-sig-demo-local-site`. **Dynamo · Remote Pool** (`site-pool`) runs in the separate Site cluster `kind-grid-sig-demo-site` and GridSite `grid-sig-demo-remote-site`. The Hub Gateway compares A and B; the Site Gateway handles cross-site routing.
3. Wait for `3/3 POOLS LIVE`, all three `model_ready` values at `1 · READY`, matching published and consumed local overlay revisions, and `LIVE` Site Gateway scores for all three candidates. `./scripts/check-live-readiness.sh` checks that the remote snapshot is fresh too.
4. Confirm pool A shows the declared `dynamo-mocker-bounded-4-v1` profile and a separately labeled Grid comparison reference of `4`. The active gauge itself is a plain count, such as `active_requests 0`. Four is a test comparison reference, not a Dynamo queue limit, Mocker replica count, or measured serving capacity. Keep the identity panel collapsed unless identifying the source is part of the take.
5. At 1440 × 900, the dashboard leaves a 90 px lower caption-safe strip clear. The optional peer condition stays collapsed until its sequence; use **Optional peer test** to jump to it.

## Main recording sequence

1. Record the baseline screen with two sites, three actual Frontend metric sources, and all three pool cards visible. The Hub local overlay table lists only Pool A and Pool B. Its note links to the separate Site Gateway snapshot, which lists Pool A, Pool B, and the Remote Pool. Use **below ↓** in that note if the snapshot is below the fold. Pool A and Pool B are separate Dynamo Frontend + Mocker Pods in the Hub cluster; the Remote Pool is in the Site cluster.
2. Set **Requests** to `24` and click **Generate requests**. This sends a bounded batch through the Site Gateway and lets its current GridSiteRoute snapshot select a pool for each request. It is not pinned to a selected pool. Wait for **SAMPLE COMPLETE** and read each pool's sample count and Site Gateway attribution.
3. Click **Reset counters**. The pool-card totals now show Site Gateway counter deltas since this reset. This changes only the display baseline; the actual Gateway Prometheus counters remain cumulative. The per-sample counts remain labeled separately.
4. In **Dynamo · Pool A**, click **Generate pressure**. Wait for `PRESSURE OBSERVED`, a positive plain `active_requests` count, a changed Hub overlay revision consumed by the Hub Gateway, and a fresh Site Gateway pressure signal. A Hub route probe can now show local A/B selection using its unique Gateway counter delta; the Hub route does not emit response attribution headers.
5. While Pool A remains pressured, click **Generate pressure** in **Dynamo · Pool B**. Wait until both cards show `PRESSURE OBSERVED`, both live Frontend gauges show active work, the **Site Gateway candidate score and rank** table ranks the remote pool ahead of both pressured local pools, and the Hub overlay has converged to the published revision.
6. Click **Reset counters**, then set **Requests** to `24` and click **Generate requests**. This new batch goes through the Site Gateway's live route snapshot. In the qualified run, the counters showed `0` for Pool A, `0` for Pool B, and `24` for the unpressured Remote Pool, with all 24 responses carrying valid Site Gateway site/backend attribution. This proves the two pressured pools were avoided for that sample; it does not claim weighted-share precision.
7. Click **Reset pressure** beside **Reset counters** (or **Recover all pools** in Presenter controls). The global button releases every pool, including runs already showing **RECOVERING**. Wait for fresh zero-active gauges, a converged Hub overlay, and recovered Site Gateway scores. Generate another 24-request sample; local traffic should return, with a variable distribution. The global button remains available during a Site Gateway sample; that sample continues through the pressure transition, so wait for **SAMPLE COMPLETE** first when you want a clean pressure-only count. A Hub route probe after recovery selects from the local A/B overlay and does not use Site Gateway attribution headers.
8. To demonstrate pressure on any single target, click **Generate pressure** in that pool's card. The same card changes to **Recover pool**; the presenter panel also has **Recover all pools**. For the Remote Pool, the Site Gateway evaluates its own candidate score/rank; the remote adapter is not part of the Hub local overlay.
9. Optional: click **Optional peer test**, then expand the signal endpoint panel. Interrupt the Hub peer signal endpoint. Wait until the Site Gateway freshness window has elapsed, Hub candidate scores show UNAVAILABLE, the local Site pool sample stays fresh, and **Probe local fallback** becomes enabled. Send the probe and verify the Site pool attribution. Restore peer signals, wait for all Site Gateway candidates to become fresh, then use **Probe restored route** and inspect the route's actual attribution. The destination follows the restored live snapshot; the UI does not force a remote route on a tie.
10. Click **Reset baseline** and wait for its fresh successful probe before another take. A stopped partial request sample returns to `IDLE`; Gateway Prometheus counters remain cumulative and the separate **Reset counters** control resets only the displayed card deltas.

## If a proof action fails

- Keep the first failed result visible; do not narrate stale data as live or retry rapidly.
- Click **Reset pressure** beside **Reset counters** to release every pool, including a run already in **RECOVERING**. The per-pool **Recover pool** control is disabled while that pool is already recovering. Each direct pressure run is bounded to 300 seconds; the global reset waits for fresh zero-active signals and route recovery.
- Pressure starts only after you click **Generate pressure** on a pool card; opening or refreshing the dashboard does not generate load. A run ends no later than 300 seconds after it starts.
- If the peer endpoint is interrupted, click **Restore peer signals**. Do not reset or tear down the run while restoration is pending.
- An interrupted peer does not immediately remove its last sample from the Site Gateway. Wait until the live unavailable condition has persisted beyond the visible freshness window, Hub scores show UNAVAILABLE, and **Probe local fallback** enables; an earlier route probe may still use the last fresh Hub sample.
- After signals converge, click **Reset baseline**. If it fails, use `./scripts/reset-baseline.sh` and inspect `evidence/ui-live-actions.jsonl` plus the app log.
- The Hub local `intelligent_route` path emits no site/backend/provider-site response headers. Use only the unique Gateway request-counter delta to identify its selected backend. The Site `grid_site_route` path emits site/backend headers; its provider-site header is present only when the remote provider Gateway returns it.
- If sources are unavailable or stale, leave the run on that state and use the alternate waiting line in `media/narration/ui-walkthrough-script.md`.

## Scope language

Call the telemetry actual Dynamo Frontend runtime signals and call the responses synthetic Mocker completions. Do not claim GPU saturation, model quality, weighted-share precision, llm-d/EPP queues, or a live SWIM partition. The optional failure control is a **signal endpoint interruption**.

## After recording

The local preview contains an AI-generated UI voiceover and captions aligned to the supplied historical screen recording. If the user changes the narration in the final edit, generate a new SRT from that edited audio with `./scripts/transcribe-final-walkthrough.sh /path/to/your-recording.wav`, then review terminology and validate the cue timing. The final edited video and its final captions remain with the user's edit.

The previously used run-owned clusters were removed. Provision a new run-owned environment before recording; do not assume a local listener or earlier screenshot is live evidence. The module does not currently include the provisioning script referenced by `start-ui.sh`, so complete the setup path before presenting the runbook as a standalone deployment recipe.
