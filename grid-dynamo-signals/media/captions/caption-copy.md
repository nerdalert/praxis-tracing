# Revised caption copy for the Grid × Dynamo video

Each numbered line below is one intended caption cue. The words match the
reviewed narration in `../narration/intro-script.md`,
`../narration/ui-walkthrough-script.md`, and `../narration/outro-script.md`.
The lines are **untimed**: generate narration first, then align these cues to
the actual audio and final slide and UI boundaries. The UI section windows
are relative to the original 93.766-second recording, not to the final cut.
Keep cues to at most two readable on-screen lines; rewrap without changing
technical meaning if needed. Never let a cue cross a slide or UI phase cut.

## Introduction slide 1 — What Grid does

1. Grid connects one model endpoint to serving pools across sites.
2. It tracks which providers are usable,
   evaluates routing policy and current signals,
3. and publishes a versioned routing view.
4. The Gateway uses that view to choose the next destination;
5. it does not scrape a model on every request.

## Introduction slide 2 — Operators, peers, and SWIM

1. Grid operators reconcile provider inventory,
   trust, signals, and routing state.
2. SWIM is one way sites can discover and exchange membership.
3. In this recording, the two sites instead use declared peers
   and secure signal polling.
4. The recording does not demonstrate live SWIM.
5. The Gateway serves requests from the latest accepted routing state.

## Introduction slide 3 — Praxis and the decision inputs

1. Praxis is the request-serving Gateway.
2. Grid supplies candidate state for its routing filters.
3. Think of the inputs in three buckets: eligibility,
   such as readiness, health, trust, and freshness;
4. pressure, such as queue depth, KV-cache use,
   or active requests;
5. and policy, such as region, locality, affinity,
   and configured capacity.
6. Different serving frameworks expose different measurements.
7. Only configured, comparable inputs influence a given decision.

## Introduction slide 4 — llm-d as one serving framework

1. With llm-d, an Endpoint Picker, or EPP,
   chooses a worker within a pool.
2. Its signals can include waiting requests,
   KV-cache utilization, and endpoint readiness.
3. Grid can use those pool observations
   to choose between sites or pools.
4. This slide explains another supported integration;
5. the recording that follows uses Dynamo, not llm-d.

## Introduction slide 5 — Dynamo: ready is not idle

1. A Dynamo pool can be ready to serve and still be busy.
2. In this demo, each pool has a dedicated Frontend and Mocker.
3. The Frontend reports model readiness and its active request count.
4. Grid checks freshness and compares active work
   with a configured reference of four.
5. The stage gauges give more detail,
   but they are not llm-d queues or GPU utilization.
6. Mocker returns synthetic responses.

## Introduction slide 6 — What you are about to see

1. First, we send a request sample
2. with no pool under pressure and observe
3. requests reaching all three pools.
4. Then we load Pool B and the remote pool.
5. Their Dynamo Frontend active-request metrics rise;
6. Grid updates its routing view,
   and the next sample favors unpressured Pool A.
7. Finally, we release the load and send another sample.
8. All three pools appear again.
9. The recording shows a routing shift,
   not an equal-share guarantee.

## UI 00:00–00:12 — Baseline state

1. All three Dynamo pools are ready and idle.
2. The Hub overlay ranks local pools;
3. a separate Site Gateway view includes the remote pool.

## UI 00:12–00:27 — No-pressure request sample

1. Before pressure, we send a fresh sample.
2. The counters show requests reaching Pool A,
   Pool B, and the remote pool.
3. This is observed routing, not an equal-share claim.

## UI 00:27–00:39 — Apply pressure

1. Now we load Pool B and the remote pool
   directly through Mocker.
2. Frontend active-request metrics rise
   while Pool A stays unpressured.

## UI 00:39–01:02 — Route after the metrics change

1. Grid receives fresh metrics and changes its scores.
2. The Hub's published and consumed overlay revisions match.
3. New Site Gateway requests shift toward Pool A;
   attributed counters show the chosen pool.
4. The local overlay and cross-site snapshot remain distinct.

## UI 01:02–01:22 — Release pressure

1. We release direct work.
2. Pool B and the remote Frontend return
   toward zero active requests.
3. Grid waits for fresh observations
   before the routes count as recovered.
4. Now the recovery sample runs;
   watch the per-pool counters update as responses arrive.

## UI 01:22–01:33.766 — Fresh sample after recovery

1. A final sample reaches all three pools again.
2. That shows recovery, not a guaranteed traffic share
   or GPU benchmark.

## Exit slide

1. Grid lets the serving pool behind a model route
   be supplied by different frameworks.
2. This demo used Dynamo Frontend signals.
3. Another deployment can use llm-d and its EPP signals
4. when the adapter and policy are configured for those measurements.
5. The routing interface stays consistent;
   the signal semantics still matter.
6. Explore Grid, Praxis AI, and Praxis core
   at the links on screen.
7. Thanks for watching.

## Editorial checks before timing

- Keep `Grid`, `Praxis`, `Dynamo`, `Frontend`, `Mocker`, `llm-d`, `EPP`,
  `SWIM`, `Pool A`, `Pool B`, and `remote pool` spelled as shown.
- Check the actual UI frames before asserting the no-pressure and recovered
  samples reached all three pools. Narrow the claim if the recording does not
  show it. Do not alter the recording to imply a result it did not show.
- The final SRT must reflect the words actually spoken after audio edits.
  Do not retime an old SRT or use these editorial windows as subtitle times.
